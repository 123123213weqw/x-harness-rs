use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use xharness_core::{
    AgentMessage, ProviderError, ProviderEvent, ProviderRequest, Role, ToolCall, ToolDefinition,
};

use crate::SseEvent;

pub const CHAT_COMPLETIONS: &str = "chat_completions";
pub const RESPONSES: &str = "responses";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenAiProtocol {
    ChatCompletions,
    Responses,
}

impl OpenAiProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChatCompletions => CHAT_COMPLETIONS,
            Self::Responses => RESPONSES,
        }
    }
}

pub fn build_openai_request(
    protocol: OpenAiProtocol,
    model: &str,
    request: &ProviderRequest,
) -> Value {
    let tools = request
        .tools
        .iter()
        .map(|tool| encode_tool(protocol, tool))
        .collect::<Vec<_>>();

    match protocol {
        OpenAiProtocol::ChatCompletions => {
            let mut root = json!({
                "model": model,
                "stream": true,
                "stream_options": { "include_usage": true },
                "messages": request.messages.iter().map(encode_chat_message).collect::<Vec<_>>(),
            });
            if !tools.is_empty() {
                root["tools"] = Value::Array(tools);
            }
            root
        }
        OpenAiProtocol::Responses => {
            let input = request
                .messages
                .iter()
                .flat_map(encode_response_message)
                .collect::<Vec<_>>();
            let mut root = json!({
                "model": model,
                "stream": true,
                "store": false,
                "input": input,
            });
            if !tools.is_empty() {
                root["tools"] = Value::Array(tools);
            }
            root
        }
    }
}

fn encode_tool(protocol: OpenAiProtocol, tool: &ToolDefinition) -> Value {
    match protocol {
        OpenAiProtocol::ChatCompletions => json!({
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            }
        }),
        OpenAiProtocol::Responses => json!({
            "type": "function",
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        }),
    }
}

fn encode_chat_message(message: &AgentMessage) -> Value {
    let mut object = Map::new();
    object.insert("role".to_owned(), json!(message.role.as_str()));
    object.insert("content".to_owned(), json!(message.content));
    if !message.reasoning.is_empty() {
        object.insert("reasoning_content".to_owned(), json!(message.reasoning));
    }
    if let Some(tool_call_id) = &message.tool_call_id {
        object.insert("tool_call_id".to_owned(), json!(tool_call_id));
    }
    if !message.tool_calls.is_empty() {
        object.insert(
            "tool_calls".to_owned(),
            Value::Array(
                message
                    .tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.arguments_json,
                            }
                        })
                    })
                    .collect(),
            ),
        );
    }
    Value::Object(object)
}

fn encode_response_message(message: &AgentMessage) -> Vec<Value> {
    if message.role == Role::Tool {
        return vec![json!({
            "type": "function_call_output",
            "call_id": message.tool_call_id.clone().unwrap_or_default(),
            "output": message.content,
        })];
    }
    if message.role == Role::Assistant && !message.provider_items.is_empty() {
        return message.provider_items.clone();
    }

    let content_type = if message.role == Role::Assistant {
        "output_text"
    } else {
        "input_text"
    };
    let mut output = vec![json!({
        "role": message.role.as_str(),
        "content": [{ "type": content_type, "text": message.content }],
    })];
    if message.role == Role::Assistant {
        output.extend(message.tool_calls.iter().map(encode_response_tool_call));
    }
    output
}

fn encode_response_tool_call(call: &ToolCall) -> Value {
    json!({
        "type": "function_call",
        "call_id": call.id,
        "name": call.name,
        "arguments": call.arguments_json,
    })
}

#[derive(Clone, Debug)]
pub struct OpenAiStreamNormalizer {
    protocol: OpenAiProtocol,
    usage: Option<Value>,
    provider_items: Vec<Value>,
    provider_item_encodings: HashSet<String>,
    argument_seen: HashSet<usize>,
    completed: bool,
}

impl OpenAiStreamNormalizer {
    pub fn new(protocol: OpenAiProtocol) -> Self {
        Self {
            protocol,
            usage: None,
            provider_items: Vec::new(),
            provider_item_encodings: HashSet::new(),
            argument_seen: HashSet::new(),
            completed: false,
        }
    }

    pub fn consume(&mut self, event: SseEvent) -> Result<Vec<ProviderEvent>, ProviderError> {
        if self.protocol == OpenAiProtocol::ChatCompletions && event.data == "[DONE]" {
            self.completed = true;
            return Ok(vec![ProviderEvent::Completed {
                usage: self.usage.clone(),
                provider_items: Vec::new(),
            }]);
        }
        let root: Value = serde_json::from_str(&event.data)
            .map_err(|error| ProviderError::new(format!("invalid SSE JSON payload: {error}")))?;
        match self.protocol {
            OpenAiProtocol::ChatCompletions => self.consume_chat(root),
            OpenAiProtocol::Responses => self.consume_responses(root),
        }
    }

    pub fn finish(&self) -> Result<(), ProviderError> {
        if self.completed {
            Ok(())
        } else {
            Err(ProviderError::new(
                "SSE stream ended before protocol completion",
            ))
        }
    }

    fn consume_chat(&mut self, root: Value) -> Result<Vec<ProviderEvent>, ProviderError> {
        if let Some(usage) = root.get("usage").filter(|value| !value.is_null()) {
            self.usage = Some(usage.clone());
        }
        if let Some(error) = root.get("error").filter(|value| !value.is_null()) {
            return Err(ProviderError::new(error_message(error)));
        }
        let Some(delta) = root
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("delta"))
        else {
            return Ok(Vec::new());
        };
        let mut output = Vec::new();
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            if !text.is_empty() {
                output.push(ProviderEvent::TextDelta(text.to_owned()));
            }
        }
        let reasoning = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !reasoning.is_empty() {
            output.push(ProviderEvent::ReasoningDelta(reasoning.to_owned()));
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for (fallback_index, call) in calls.iter().enumerate() {
                let function = call.get("function").unwrap_or(&Value::Null);
                output.push(ProviderEvent::ToolCallDelta {
                    index: call
                        .get("index")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize)
                        .unwrap_or(fallback_index),
                    id: string_field(call, "id"),
                    name: string_field(function, "name"),
                    arguments_delta: string_field(function, "arguments"),
                });
            }
        }
        Ok(output)
    }

    fn consume_responses(&mut self, root: Value) -> Result<Vec<ProviderEvent>, ProviderError> {
        let event_type = string_field(&root, "type");
        let index = root
            .get("output_index")
            .and_then(Value::as_u64)
            .unwrap_or_default() as usize;
        let output = match event_type.as_str() {
            "response.output_text.delta" => {
                vec![ProviderEvent::TextDelta(string_field(&root, "delta"))]
            }
            "response.reasoning_text.delta" | "response.reasoning_summary_text.delta" => {
                vec![ProviderEvent::ReasoningDelta(string_field(&root, "delta"))]
            }
            "response.function_call_arguments.delta" => {
                let delta = string_field(&root, "delta");
                if !delta.is_empty() {
                    self.argument_seen.insert(index);
                }
                vec![ProviderEvent::ToolCallDelta {
                    index,
                    id: String::new(),
                    name: String::new(),
                    arguments_delta: delta,
                }]
            }
            "response.output_item.added" => {
                if let Some(item) = root
                    .get("item")
                    .filter(|item| string_field(item, "type") == "function_call")
                {
                    let arguments = string_field(item, "arguments");
                    if !arguments.is_empty() {
                        self.argument_seen.insert(index);
                    }
                    vec![function_call_event(index, item, arguments)]
                } else {
                    Vec::new()
                }
            }
            "response.output_item.done" => {
                let Some(item) = root.get("item") else {
                    return Ok(Vec::new());
                };
                self.retain_item(item.clone());
                if string_field(item, "type") == "function_call"
                    && !self.argument_seen.contains(&index)
                {
                    let arguments = string_field(item, "arguments");
                    if !arguments.is_empty() {
                        self.argument_seen.insert(index);
                    }
                    vec![function_call_event(index, item, arguments)]
                } else {
                    Vec::new()
                }
            }
            "response.completed" => {
                if let Some(response) = root.get("response") {
                    if let Some(usage) = response.get("usage").filter(|value| !value.is_null()) {
                        self.usage = Some(usage.clone());
                    }
                    if let Some(items) = response.get("output").and_then(Value::as_array) {
                        for item in items {
                            self.retain_item(item.clone());
                        }
                    }
                }
                self.completed = true;
                vec![ProviderEvent::Completed {
                    usage: self.usage.clone(),
                    provider_items: self.provider_items.clone(),
                }]
            }
            "error" | "response.failed" | "response.incomplete" => {
                let message = root
                    .get("error")
                    .map(error_message)
                    .unwrap_or_else(|| "OpenAI Responses stream failed".to_owned());
                return Err(ProviderError::new(message));
            }
            _ => Vec::new(),
        };
        Ok(output)
    }

    fn retain_item(&mut self, item: Value) {
        let encoding = item.to_string();
        if self.provider_item_encodings.insert(encoding) {
            self.provider_items.push(item);
        }
    }
}

fn function_call_event(index: usize, item: &Value, arguments_delta: String) -> ProviderEvent {
    ProviderEvent::ToolCallDelta {
        index,
        id: {
            let call_id = string_field(item, "call_id");
            if call_id.is_empty() {
                string_field(item, "id")
            } else {
                call_id
            }
        },
        name: string_field(item, "name"),
        arguments_delta,
    }
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn error_message(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| error.to_string())
}
