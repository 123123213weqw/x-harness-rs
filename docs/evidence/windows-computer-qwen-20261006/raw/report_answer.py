"""Extract reported values without treating prose as strict JSON compliance."""
import json,re

def reported_answer(text):
    try:
        value=json.loads(text)
        return value,True,'json_only'
    except json.JSONDecodeError:
        pass
    blocks=re.findall(r'```json\s*(.*?)\s*```',text,re.S)
    if blocks:
        if len(blocks)!=1:raise ValueError('Ambiguous JSON blocks')
        return json.loads(blocks[0]),False,'prose_and_json_fence'
    lines=text.strip().splitlines()
    if not lines or any('{' in line or '}' in line or '```' in line for line in lines[:-1]):
        raise ValueError('No unique standalone final JSON object')
    value=json.loads(lines[-1])
    if not isinstance(value,dict):raise ValueError('Final value is not an object')
    return value,False,'prose_and_json_last_line'
