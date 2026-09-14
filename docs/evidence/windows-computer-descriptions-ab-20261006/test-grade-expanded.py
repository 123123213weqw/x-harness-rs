import unittest, importlib.util
from pathlib import Path
s=importlib.util.spec_from_file_location('oracle',Path(__file__).with_name('grade-expanded.py'));o=importlib.util.module_from_spec(s);s.loader.exec_module(o)
class Tests(unittest.TestCase):
 def test_search_cannot_be_self_reported(self):
  answer={'products':o.EXPECTED};events=[{'type':'initial','scenario':'modal'}]
  self.assertFalse(o.grade('modal',answer,events)['pass'])
  events += [{'type':'dismiss_modal','scenario':'modal'},{'type':'search','scenario':'modal','query':'SSD','visible':['orion','lyra','nova','qlc','short','gen3','weak','small']}]
  self.assertTrue(o.grade('modal',answer,events)['pass'])
  self.assertFalse(o.grade('modal',answer,events,error='unknown')['pass'])
  events.append({'type':'initial','scenario':'modal'});self.assertFalse(o.grade('modal',answer,events)['pass'])
 def test_navigation_order_and_scroll(self):
  answer={'name':'Accessory 779','price':98,'returned':True};events=[{'type':'initial','scenario':'scroll-detail'},{'type':'scroll','scenario':'scroll-detail','scrollY':800},{'type':'navigate_detail','scenario':'scroll-detail','detail':{'id':'other-779'},'seq':3},{'type':'return_products','scenario':'scroll-detail','seq':4}]
  self.assertTrue(o.grade('scroll-detail',answer,events)['pass']);events[-1]['seq']=2;self.assertFalse(o.grade('scroll-detail',answer,events)['pass'])
 def test_filter_requires_exact_external_state(self):
  answer={'sorted_names':o.SORTED,'compared':o.EXPECTED};events=[{'type':'initial','scenario':'filter'},{'type':'sort','scenario':'filter','query':'SSD','tlc':True,'order':'asc','visible':o.IDS},{'type':'compare','scenario':'filter','tlc':True,'order':'asc','visible':o.IDS,'detail':{'ids':['orion','lyra']}}]
  self.assertTrue(o.grade('filter',answer,events)['pass']);events[1]['query']='';self.assertTrue(o.grade('filter',answer,events)['pass']);answer['compared']=list(reversed(answer['compared']));self.assertTrue(o.grade('filter',answer,events)['pass']);events[-1]['visible']=list(reversed(o.IDS));self.assertFalse(o.grade('filter',answer,events)['pass'])
 def test_filter_cannot_reuse_an_earlier_correct_state(self):
  answer={'sorted_names':o.SORTED,'compared':o.EXPECTED};good={'type':'compare','scenario':'filter','tlc':True,'order':'asc','visible':o.IDS,'detail':{'ids':['orion','lyra']}}
  events=[{'type':'initial','scenario':'filter'},good];self.assertTrue(o.grade('filter',answer,events)['pass'])
  events.append({**good,'type':'sort','order':'desc','visible':list(reversed(o.IDS))});self.assertFalse(o.grade('filter',answer,events)['pass'])
  events[-1]={**good,'detail':{'ids':['orion','short']}};self.assertFalse(o.grade('filter',answer,events)['pass'])
  events[-1]={'type':'compare','scenario':'filter','detail':{'ids':['orion','lyra']}};self.assertFalse(o.grade('filter',answer,events)['pass'])
 def test_exact_currency_not_ambiguous_values(self):
  answer={'products':[{'name':'Orion Pro SSD','price':'CNY 549'},{'name':'Lyra Plus SSD','price':'CNY 599'}]};events=[{'type':'initial','scenario':'modal'},{'type':'dismiss_modal','scenario':'modal'},{'type':'search','scenario':'modal','query':'SSD','visible':['orion','lyra','nova','qlc','short','gen3','weak','small']}]
  result=o.grade('modal',answer,events);self.assertTrue(result['pass']);self.assertFalse(result['report_field_types_ok'])
  for bad in ['CNY 599','USD 549','549 or 599',True,None]:
   answer['products'][0]['price']=bad;self.assertFalse(o.grade('modal',answer,events)['pass'])
 def test_cart_and_wrong_prices_fail(self):
  answer={'products':o.EXPECTED};events=[{'type':'initial','scenario':'slow-layout'},{'type':'layout_shift','scenario':'slow-layout'},{'type':'search','scenario':'slow-layout','query':'SSD','visible':['orion','lyra','nova','qlc','short','gen3','weak','small']}]
  self.assertTrue(o.grade('slow-layout',answer,events)['pass']);events.append({'type':'add_to_cart','scenario':'slow-layout','cart':['orion']});self.assertFalse(o.grade('slow-layout',answer,events)['pass'])
unittest.main()
