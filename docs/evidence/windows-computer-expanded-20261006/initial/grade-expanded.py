"""Independent page-event + answer oracle. Never accepts model self-assessment."""
import json, re, math
TASKS={
 'filter': 'Using the current shop, show SSD products with TLC only, sorted by price low to high. Compare exactly Orion Pro SSD and Lyra Plus SSD using the page comparison feature. Report JSON {"sorted_names":[all filtered names in displayed order],"compared":[{"name":...,"price":...},{"name":...,"price":...}]}. Do not add to cart.',
 'scroll-detail': 'Without using search, find Accessory 779 by scrolling the product list. Open its Details page, verify its name and price, then return to the product list using the page control. Report JSON {"name":"...","price":number,"returned":true}. Do not add to cart.',
 'modal': 'Browse this shop and submit SSD using the page search. Read the first two result names and CNY prices. If an announcement obscures the page, handle it as needed. Report JSON {"products":[{"name":...,"price":...},{"name":...,"price":...}]}. Do not add to cart.',
 'slow-layout': 'Submit SSD using the page search, then read the first two result names and CNY prices after the search completes. The page may be slow or change layout. Report JSON {"products":[{"name":...,"price":...},{"name":...,"price":...}]}. Do not add to cart.'}
EXPECTED=[{'name':'Orion Pro SSD','price':549},{'name':'Lyra Plus SSD','price':599}]
SORTED=['Orion Small SSD','Classic SSD','Rapid Mini SSD','Light SSD','Orion Pro SSD','Lyra Plus SSD','Nova Max SSD']
IDS=['small','gen3','short','weak','orion','lyra','nova']
def price_value(value):
 if type(value) in (int,float):return value if math.isfinite(value) else None
 if isinstance(value,str):
  match=re.fullmatch(r'(?:CNY\s+)?(\d+(?:\.\d+)?)',value.strip())
  if match:return float(match[1])
 return None

def normalize_report(answer):
 if not isinstance(answer,dict):return {},False
 result=dict(answer);typed=bool(set(result)&{'products','compared','price'})
 for key in ('products','compared'):
  if isinstance(result.get(key),list):
   items=[]
   for item in result[key]:
    if not isinstance(item,dict):items.append(item);typed=False;continue
    value=dict(item);typed=typed and type(value.get('price')) in (int,float);value['price']=price_value(value.get('price'));items.append(value)
   result[key]=items
 if 'price' in result:typed=typed and type(result['price']) in (int,float);result['price']=price_value(result['price'])
 return result,typed

def grade(case,answer,events,error=None):
 starts=[i for i,e in enumerate(events) if e.get('type')=='initial' and e.get('scenario')==case]
 current=[e for e in events[starts[-1]+1:] if e.get('scenario')==case] if starts else []
 checks={'fresh_reset':bool(starts),'no_controller_error':error is None,'no_cart':not any(e.get('cart') or e.get('type') in ('add_to_cart','view_cart') for e in current)}
 answer,field_types_ok=normalize_report(answer)
 def seen(kind,predicate=lambda e:True):return any(e.get('type')==kind and predicate(e) for e in current)
 if case=='filter':
  checks.update(filtered_sorted=seen('sort',lambda e:e.get('tlc') is True and e.get('order')=='asc' and e.get('visible')==IDS) or seen('filter',lambda e:e.get('tlc') is True and e.get('order')=='asc' and e.get('visible')==IDS),
     comparison=seen('compare',lambda e:sorted(e.get('detail',{}).get('ids',[]))==['lyra','orion']),answer_exact=answer.get('sorted_names')==SORTED and isinstance(answer.get('compared'),list) and len(answer['compared'])==2 and all(item in answer['compared'] for item in EXPECTED))
 elif case=='scroll-detail':
  nav=[e for e in current if e.get('type')=='navigate_detail' and e.get('detail',{}).get('id')=='other-779']
  checks.update(scrolled=seen('scroll',lambda e:e.get('scrollY',0)>0),detail_opened=bool(nav),returned=bool(nav) and seen('return_products',lambda e:e.get('seq',0)>nav[-1].get('seq',0)),no_search=not seen('search_started'),answer_exact=answer.get('name')=='Accessory 779' and type(answer.get('price')) in (float,int) and answer['price']==98 and answer.get('returned') is True)
 else:
  checks.update(search=seen('search',lambda e:e.get('query')=='SSD' and e.get('visible')==['orion','lyra','nova','qlc','short','gen3','weak','small']),answer_exact=answer.get('products')==EXPECTED)
  if case=='modal':checks['modal_dismissed']=seen('dismiss_modal')
  if case=='slow-layout':checks['layout_shift']=seen('layout_shift')
 return {'case':case,'pass':all(checks.values()),'checks':checks,'events':len(current),'report_field_types_ok':field_types_ok}
