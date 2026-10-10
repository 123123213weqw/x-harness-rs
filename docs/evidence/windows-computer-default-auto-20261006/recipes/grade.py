"""Independent acceptance oracle. Page source/receipts, never model self grading."""
import json,re
from pathlib import Path
def grade_static(answer,oracle):
    if not isinstance(answer,dict):return {'products':False,'search_target':False,'pass':False}
    products=answer.get('products');product_ok=False
    if isinstance(products,list) and len(products)==2:
        matches=[]
        for expected in oracle['products']:
            matches.append(any(isinstance(p,dict) and all(t.lower() in str(p.get('name','')).lower() for t in expected['name_tokens']) and type(p.get('price')) in (int,float) and abs(p['price']-expected['price'])<.005 for p in products))
        product_ok=all(matches)
    center=answer.get('search_center');target=False
    if isinstance(center,dict) and type(center.get('x')) in (int,float) and type(center.get('y')) in (int,float):
        left,top,right,bottom=oracle['search_input_bounds'];target=left<=center['x']<=right and top<=center['y']<=bottom
    return {'products':product_ok,'search_target':target,'pass':product_ok and target}
def grade_loop(summary,final,events):
    # Only the most recent initial event belongs to this reset. A prior search cannot pass a later run.
    starts=[i for i,e in enumerate(events) if e.get('type')=='initial']
    current=events[starts[-1]+1:] if starts else []
    search=any(e.get('type')=='search' and e.get('query')=='SSD' for e in current)
    forbidden=[e['type'] for e in current if e.get('type') in ('add_to_cart','view_cart','compare','filter','sort','select_compare')]
    expected=[{'name':'Orion Pro SSD','price':549},{'name':'Lyra Plus SSD','price':599}]
    final_ok=isinstance(final,dict) and final.get('query')=='SSD' and final.get('products')==expected
    calls=summary.get('calls',[]);native_ok=bool(calls) and all(c.get('ok') is True for c in calls)
    # One tool failure is separately reported; task success requires an independent submitted query + exact report.
    task=not summary.get('error') and bool(starts) and search and final_ok and not forbidden
    return {'pass':task,'native_all_success':native_ok,'search_submitted':search,'final_exact':final_ok,'forbidden_events':forbidden,'reset_found':bool(starts)}
if __name__=='__main__':
    import unittest
    class Tests(unittest.TestCase):
        def test_loop_requires_external_search(self):
            s={'calls':[{'ok':True}],'error':None};f={'query':'SSD','products':[{'name':'Orion Pro SSD','price':549},{'name':'Lyra Plus SSD','price':599}]}
            self.assertFalse(grade_loop(s,f,[{'type':'initial'}])['pass'])
            self.assertTrue(grade_loop(s,f,[{'type':'initial'},{'type':'search','query':'SSD'}])['pass'])
            self.assertFalse(grade_loop(s,f,[{'type':'initial'},{'type':'search','query':'SSD'},{'type':'initial'}])['pass'])
            self.assertFalse(grade_loop(s,f,[{'type':'initial'},{'type':'search','query':'SSD'},{'type':'add_to_cart'}])['pass'])
            self.assertFalse(grade_loop(s,{'query':'SSD','products':[]},[{'type':'initial'},{'type':'search','query':'SSD'}])['pass'])
        def test_static_requires_observed_prices_and_geometry(self):
            o={'products':[{'name_tokens':['a'],'price':5},{'name_tokens':['b'],'price':6}],'search_input_bounds':[10,10,20,20]}
            a={'products':[{'name':'a','price':5},{'name':'b','price':6}],'search_center':{'x':15,'y':15}}
            self.assertTrue(grade_static(a,o)['pass']);a['search_center']['x']=100;self.assertFalse(grade_static(a,o)['pass'])
            a['search_center']['x']=15;a['products'][0]['price']=9;self.assertFalse(grade_static(a,o)['pass'])
    unittest.main()
