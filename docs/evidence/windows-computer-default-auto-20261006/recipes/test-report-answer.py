import unittest
from report_answer import reported_answer
from grade import grade_loop
class Tests(unittest.TestCase):
 def test_format_is_separate_from_values(self):
  answer={'query':'SSD','products':[{'name':'Orion Pro SSD','price':549},{'name':'Lyra Plus SSD','price':599}]}
  import json
  for text,strict in [(json.dumps(answer),True),('Done\n```json\n'+json.dumps(answer)+'\n```',False),('Done\n'+json.dumps(answer),False)]:
   value,got,_=reported_answer(text);self.assertEqual(got,strict);self.assertEqual(value,answer)
   self.assertTrue(grade_loop({'calls':[{'ok':True}]},value,[{'type':'initial'},{'type':'search','query':'SSD'}])['pass'])
  answer['products'][0]['price']=1
  self.assertFalse(grade_loop({'calls':[{'ok':True}]},answer,[{'type':'initial'},{'type':'search','query':'SSD'}])['pass'])
 def test_ambiguous_and_unparseable_are_not_accepted(self):
  for text in ['{}\n{}','```json\n{}\n```\n```json\n{}\n```','No JSON here','Done\n[1]','Some {invalid}\n{}']:
   with self.assertRaises(ValueError):reported_answer(text)
if __name__=='__main__':unittest.main()
