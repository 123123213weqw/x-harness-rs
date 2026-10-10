"""Private controller. Native registered tool only; no browser DOM injection."""
import os,pathlib,json,urllib.request,urllib.error,time,subprocess,hashlib,base64,io
from PIL import Image
ROOT=pathlib.Path(os.environ['XHARNESS_COMPUTER_LAB_ROOT']).resolve()
HTTP=urllib.request.build_opener(urllib.request.ProxyHandler({}))
BASE=os.environ.get('XHARNESS_COMPUTER_LAB_URL','http://127.0.0.1:11903')
assert __import__('urllib.parse',fromlist=['urlparse']).urlparse(BASE).hostname in ('127.0.0.1','localhost')
def local(path,value=None):
    req=urllib.request.Request(BASE+path,data=None if value is None else json.dumps(value).encode(),headers={'Content-Type':'application/json'})
    with HTTP.open(req,timeout=45) as r:return r.read()
class Model:
    def __init__(self):
        self.p={'base_url':'http://127.0.0.1:18059/v1'}
        self.key=None
    def send(self,messages,tool=None):
        body={'model':'qwen3.8-27b-uncensored','messages':messages,'max_tokens':1400,'chat_template_kwargs':{'enable_thinking':False},'temperature':0}
        if tool:body.update(tools=[tool],tool_choice='auto')
        request=urllib.request.Request(self.p['base_url'].rstrip('/')+'/chat/completions',data=json.dumps(body).encode(),headers={'Content-Type':'application/json','X-XHarness-Experiment':'qwen-computer-20261006'})
        start=time.monotonic()
        try:
            with HTTP.open(request,timeout=120) as r:value=json.load(r)
        except urllib.error.HTTPError as e:
            error=e.read().decode(errors='replace')
            raise RuntimeError(f'Provider HTTP {e.code}: {error}') from None
        message={k:v for k,v in value['choices'][0]['message'].items() if k in ('role','content','tool_calls')}
        return {'message':message,'model':value.get('model'),'usage':value.get('usage',{}),'finish_reason':value['choices'][0].get('finish_reason'),'model_s':time.monotonic()-start}
def image_block(data):
    return {'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(data).decode(),'detail':'high'}}
def parse_json(text):
    return json.loads(text.strip().removeprefix('```json').removeprefix('```').removesuffix('```').strip())
def parse_final(text):
    import re
    try:return parse_json(text), True
    except (ValueError,TypeError):
        blocks=re.findall(r'```json\s*(.*?)\s*```',text,re.S)
        if len(blocks)!=1:raise ValueError('Expected exactly one final JSON block')
        return json.loads(blocks[0]), False
def native(args,directory):
    directory.mkdir(parents=True,exist_ok=True)
    index_file=ROOT/'next-id.json';index=json.loads(index_file.read_text()) if index_file.exists() else 0
    # Reserve before dispatch. A timeout never reuses this id or retries the action.
    index_file.write_text(json.dumps(index+1));(directory/f'request-{index}.json').write_text(json.dumps(args,indent=2))
    start=time.monotonic();local('/browser-job',{'id':index,'request':args})
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        value=json.loads(local('/browser-latest'))
        if value.get('id')==index and 'ok' in value:break
        if value.get('phase')=='finished':raise RuntimeError('Native bridge exited; never replay action')
        time.sleep(.35)
    else:raise TimeoutError('Missing receipt; outcome unknown, no replay')
    value['controller_wall_s']=time.monotonic()-start
    (directory/f'receipt-{index}.json').write_text(json.dumps(value,indent=2))
    image=None
    if value.get('media'):
        image=local(f'/browser-image/{index}.png');media=value['media']
        if hashlib.sha256(image).hexdigest()!=media['sha256'] or len(image)!=media['png_bytes']:raise RuntimeError('PNG transport digest mismatch')
        im=Image.open(io.BytesIO(image));im.verify()
        if Image.open(io.BytesIO(image)).size!=(media['width'],media['height']):raise RuntimeError('PNG dimensions mismatch')
        (directory/f'image-{index}.png').write_bytes(image)
    print(json.dumps({'id':index,'action':args['action'],'ok':value['ok'],'native_ms':value['elapsed_ms'],'wall_s':round(value['controller_wall_s'],2),'image':bool(image)}),flush=True)
    return value,image
MODES={'uia':{'include_accessibility':True,'include_screenshot':False,'detail':'semantic'},'vision':{'include_accessibility':False,'include_screenshot':True,'detail':'auto'},'hybrid':{'include_accessibility':True,'include_screenshot':True,'detail':'auto'}}
def tool_content(value,image):
    text=json.dumps({k:v for k,v in value.items() if k in ('ok','result','failure','elapsed_ms')},ensure_ascii=False)
    if image:return [{'type':'text','text':text},image_block(image)]
    return text

# Diagnostics only: include media download/postprocessing omitted by receipt wait time.
_native_before_telemetry=native
def native(args,directory):
    started=time.monotonic()
    value,image=_native_before_telemetry(args,directory)
    value['complete_controller_wall_s']=time.monotonic()-started
    value['media_and_postprocessing_s']=value['complete_controller_wall_s']-value['controller_wall_s']
    (directory/f"receipt-{value['id']}.json").write_text(json.dumps(value,indent=2))
    return value,image
