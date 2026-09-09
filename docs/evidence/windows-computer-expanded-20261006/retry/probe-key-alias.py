from experiment import *
d=ROOT/'diagnostic'/'key-alias';d.mkdir(parents=True,exist_ok=False)
v,_=native({'action':'observe','include_accessibility':False,'include_screenshot':False},d);assert v['ok']
v,_=native({'action':'keypress','frame_id':v['result']['frame_id'],'keys':['Page_Up'],'include_accessibility':False,'include_screenshot':False},d)
(d/'result.json').write_text(json.dumps({'model_controlled':False,'request_key':'Page_Up','ok':v['ok'],'failure':v.get('failure'),'no_action_replay':True},indent=2));print(json.dumps(v.get('failure')))
