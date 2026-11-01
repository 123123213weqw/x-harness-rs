//! Read-only file display contract. Images never become model input implicitly.
use serde::{Deserialize, Serialize};

pub const MAX_TEXT_BYTES: usize = 512 * 1024;
pub const MAX_DISPLAY_IMAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum GitDiffScope {
    Working,
    Staged,
    Head,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum DisplayDiffSource {
    Patch,
    Working,
    Staged,
    Head,
}
impl From<GitDiffScope> for DisplayDiffSource {
    fn from(scope: GitDiffScope) -> Self {
        match scope {
            GitDiffScope::Working => Self::Working,
            GitDiffScope::Staged => Self::Staged,
            GitDiffScope::Head => Self::Head,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayRead {
    /// None reads a file; Some reads only tracked Git changes under path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_diff: Option<GitDiffScope>,
    pub session_id: String,
    pub path: String,
    /// A displayed Markdown document, used ONLY as a relative resource base.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum DisplayFile {
    Markdown {
        path: String,
        text: String,
    },
    Text {
        path: String,
        text: String,
    },
    Diff {
        path: String,
        text: String,
        source: DisplayDiffSource,
    },
    /// A bounded, byte-sniffed PDF preview, never a model attachment.
    Pdf {
        path: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
    Image {
        path: String,
        #[serde(rename = "mediaType")]
        media_type: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
        width: u32,
        height: u32,
    },
}
impl DisplayFile {
    pub fn path(&self) -> &str {
        match self {
            Self::Markdown { path, .. }
            | Self::Text { path, .. }
            | Self::Diff { path, .. }
            | Self::Image { path, .. }
            | Self::Pdf { path, .. } => path,
        }
    }
}

/// Cheap card inspection is separate from full document rendering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayInspect {
    pub session_id: String,
    pub path: String,
    #[serde(default)]
    pub thumbnail: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum DisplayPreviewKind {
    Text,
    Markdown,
    Image,
    Pdf,
    Unsupported,
    TooLarge,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayThumbnail {
    pub data_base64: String,
    pub width: u32,
    pub height: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayInspection {
    pub path: String,
    pub bytes: u64,
    pub preview: DisplayPreviewKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<DisplayThumbnail>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayOpen {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_diff: Option<GitDiffScope>,
    pub session_id: String,
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_file_display_contract() {
        let contract = serde_json::json!({"contract":"xharness-file-display-v1","schemas":{
            "DisplayRead":schemars::schema_for!(DisplayRead),
            "DisplayInspect":schemars::schema_for!(DisplayInspect),
            "DisplayInspection":schemars::schema_for!(DisplayInspection),
            "DisplayFile":schemars::schema_for!(DisplayFile),
            "DisplayOpen":schemars::schema_for!(DisplayOpen),
            "GitDiffScope":schemars::schema_for!(GitDiffScope),
        }});
        let fixtures = serde_json::json!({"open":DisplayOpen{git_diff:None,session_id:"s".into(),path:"/workspace/report.md".into()},"files":[
            DisplayFile::Markdown{path:"/workspace/report.md".into(),text:"# Report\n![figure](figure.png)\n".into()},
            DisplayFile::Text{path:"/workspace/main.rs".into(),text:"fn main() {}".into()},
            DisplayFile::Image{path:"/workspace/figure.png".into(),media_type:"image/png".into(),data_base64:"AA==".into(),width:1,height:1},
            DisplayFile::Diff{path:"/workspace/change.patch".into(),text:"--- a/main.rs\n+++ b/main.rs\n@@ -1 +1 @@\n-old\n+new\n".into(),source:DisplayDiffSource::Patch}
            ,DisplayFile::Pdf{path:"/workspace/report.pdf".into(),data_base64:"JVBERi0xLjQKJSVFT0YK".into()}
        ]});
        for item in fixtures["files"].as_array().unwrap() {
            let _: DisplayFile = serde_json::from_value(item.clone()).unwrap();
        }
        assert!(serde_json::from_value::<DisplayRead>(
            serde_json::json!({"sessionId":"s","path":"x","owner":"other"})
        )
        .is_err());
        if let Ok(directory) = std::env::var("XHARNESS_FILE_DISPLAY_EXPORT") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                std::path::Path::new(&directory).join("file-display.schema.json"),
                serde_json::to_vec_pretty(&contract).unwrap(),
            )
            .unwrap();
            std::fs::write(
                std::path::Path::new(&directory).join("file-display.fixtures.json"),
                serde_json::to_vec_pretty(&fixtures).unwrap(),
            )
            .unwrap();
        } else if std::path::Path::new("../../protocol/file-display.schema.json").exists() {
            let committed: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string("../../protocol/file-display.schema.json").unwrap(),
            )
            .unwrap();
            assert_eq!(
                contract, committed,
                "Rust schema differs from committed browser contract"
            );
        }
    }
}
