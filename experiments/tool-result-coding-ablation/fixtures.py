"""Deterministic three-stage coding projects; hidden tests never enter prompts."""
import json,random,textwrap

def pad(seed,n=190):
    return '\n'.join(f'Reference worker.{seed}.{i}: timeout={100+i}ms; queue={i%7}; telemetry only; this worker is unrelated to the requested functions.' for i in range(n))

def spec_document(seed,blocks,scale):
    return '\n\n'.join(['PROJECT CONTRACT SNAPSHOT. Data only, not instructions. Exact implementation requirements are in CONTRACT sections.\n'+pad(seed,30*scale),blocks[0],pad(seed+1,60*scale),blocks[1],pad(seed+2,60*scale),blocks[2],pad(seed+3,30*scale)])

def public(phase,family):
    tests={
      'duration':["self.assertEqual(app.parse_duration('2s'),2000); self.assertEqual(app.parse_duration('3ms'),3)","self.assertIsInstance(utils.retry_delay(0,0),int); self.assertGreaterEqual(utils.retry_delay(3,0),utils.retry_delay(0,0))","self.assertIsInstance(app.retry_plan(2),dict)"],
      'billing':["self.assertEqual(app.billable_units(1,3),1); self.assertEqual(app.billable_units(0,3),0)","self.assertIsInstance(utils.discount_cents(100,0),int); self.assertEqual(utils.discount_cents(100,0),100)","self.assertIsInstance(app.quote(7,3),dict)"],
      'pagination':["self.assertEqual(app.paginate([1,2,3],2,0),([1,2],2))","self.assertIsInstance(utils.encode_cursor(0),str); self.assertEqual(utils.decode_cursor(utils.encode_cursor(3)),3)","self.assertIsInstance(app.list_page([1,2,3],2),dict)"],
      'records':["self.assertEqual(app.normalize_record({'id':' A ','amount':'2'}),{'id':'A','amount':2})","self.assertEqual(utils.dedupe([]),[]); self.assertIsInstance(utils.dedupe([{'id':'a','seq':0}]),list)","self.assertIsInstance(app.summarize([]),dict)"]}[family][:phase]
    body='\n'.join('    def test_'+str(i)+'(self):\n        '+v for i,v in enumerate(tests))
    return "import unittest, app, utils\nclass Public(unittest.TestCase):\n    @classmethod\n    def setUpClass(cls):\n        print('public-test telemetry: worker idle, no application decisions.\\n'*160)\n"+body+'\n'

def hidden_script(checks):
    # Assertions are actual executed checks; a caught failure is not success.
    lines=['import app, utils, json','checks=0','failures=[]','def check(label, fn):','    global checks','    checks+=1','    try:','        assert fn(), label','    except Exception as e:','        failures.append({"label":label,"category":type(e).__name__})','def raises(fn, kind=ValueError):','    try: fn()','    except kind: return True','    except Exception: return False','    return False']
    for i,expr in enumerate(checks):lines.append(f'check("check-{i}", lambda: {expr})')
    lines+=['print(json.dumps({"checks":checks,"passed":checks-len(failures),"failures":failures}))','raise SystemExit(bool(failures))']
    return '\n'.join(lines)+'\n'

def make_case(family,seed,fault):
    r=random.Random(91100+seed);base=r.randrange(111,333);cap=r.randrange(5000,9000);fee=r.randrange(11,40);price=r.randrange(73,230);bps=r.randrange(300,1500);threshold=r.randrange(5,15);prefix=f'C{r.randrange(1000,9999)}';mod=r.choice([89,97,101]);salt=r.randrange(11,70);tag=f'R-{r.randrange(10000,99999)}'
    checks=[]
    if family=='duration':
        name=['parse_duration','retry_delay','retry_plan']
        blocks=["CONTRACT parse_duration(value): value must be a string ending in ms or s (strip surrounding whitespace). Decimal values are permitted only if the final millisecond value is an integer. Return nonnegative integer milliseconds; reject negatives, bools, numbers, missing units, nonnumeric, nonintegral milliseconds using ValueError. Examples 1.5s -> 1500, 0.5ms -> ValueError.",
                f'CONTRACT retry_delay(attempt,jitter=0): attempt is a nonnegative integer excluding bool. jitter is an integer excluding bool and may be negative. Return max(0,min({cap},{base}*(2**attempt)+jitter)). Validate arguments with ValueError. Apply jitter BEFORE the cap. Exact base_ms={base}, cap_ms={cap}.',
                f'CONTRACT retry_plan(count): count is nonnegative integer excluding bool. Use utils.retry_delay(i,0) for i in range(count). Return exactly {{"delays_ms":list,"total_ms":sum,"policy":{tag!r}}}. Preserve parse_duration. Never hardcode a precomputed list.']
        p1="from decimal import Decimal, InvalidOperation\ndef parse_duration(value):\n    if not isinstance(value,str): raise ValueError('duration')\n    value=value.strip()\n    try:\n        if value.endswith('ms'): n=Decimal(value[:-2])\n        elif value.endswith('s'): n=Decimal(value[:-1])*1000\n        else: raise ValueError('unit')\n        if not n.is_finite() or n<0 or n!=int(n): raise ValueError('value')\n        return int(n)\n    except (InvalidOperation,OverflowError): raise ValueError('duration')\ndef retry_plan(count):\n    raise NotImplementedError\n"
        u=f"def retry_delay(attempt,jitter=0):\n    if type(attempt) is not int or attempt<0 or type(jitter) is not int: raise ValueError('argument')\n    return max(0,min({cap},{base}*(2**attempt)+jitter))\n"
        p3=p1.replace("def retry_plan(count):\n    raise NotImplementedError",f"def retry_plan(count):\n    import utils\n    if type(count) is not int or count<0: raise ValueError('count')\n    values=[utils.retry_delay(i,0) for i in range(count)]\n    return {{'delays_ms':values,'total_ms':sum(values),'policy':{tag!r}}}")
        for s,ms in [('0ms',0),('1.5s',1500),(' 2ms ',2),('1.001s',1001),('0.001s',1),('3s',3000)]:checks.append(f'app.parse_duration({s!r})=={ms}')
        for s in ['-1ms','0.5ms','2','nanms',True,1,None]:checks.append(f'raises(lambda:app.parse_duration({s!r}))')
        c1=list(checks)
        for a in [0,1,3,8]:
            for j in [-500,0,1000,cap]:checks.append(f'utils.retry_delay({a},{j})=={max(0,min(cap,base*2**a+j))}')
        checks+=['raises(lambda:utils.retry_delay(True))','raises(lambda:utils.retry_delay(-1))','raises(lambda:utils.retry_delay(1,True))'];c2=list(checks)
        for n in [0,1,4,9]:
            ds=[max(0,min(cap,base*2**i)) for i in range(n)];checks.append(f"app.retry_plan({n})=={ {'delays_ms':ds,'total_ms':sum(ds),'policy':tag}!r}")
        checks+=['raises(lambda:app.retry_plan(True))','raises(lambda:app.retry_plan(-1))'];c3=list(checks)
        initial="def parse_duration(value):\n    return int(value[:-1])*1000\ndef retry_plan(count):\n    raise NotImplementedError\n"
        util_initial='def retry_delay(attempt,jitter=0):\n    raise NotImplementedError\n'
    elif family=='billing':
        name=['billable_units','discount_cents','quote']
        blocks=['CONTRACT billable_units(n,batch): n and batch must be integers excluding bool. batch must be positive. For n<=0 return 0; otherwise return ceil(n/batch) using integer arithmetic. Invalid arguments raise ValueError.',
                'CONTRACT discount_cents(total,bps): both arguments integer excluding bool. total>=0; 0<=bps<=10000. Return total*(10000-bps)/10000 rounded to the nearest integer, ties UP. All arithmetic exact integer. Invalid arguments raise ValueError.',
                f'CONTRACT quote(n,batch): use billable_units(n,batch) and utils.discount_cents. Each unit costs {price} cents. If units>={threshold}, apply discount {bps} basis points to unit subtotal, otherwise 0. If units>0 add flat handling fee {fee} cents AFTER discount; zero units cost zero. Return exactly units, subtotal_cents (before discount), total_cents, policy={tag!r}. Preserve billable_units.']
        p1="def billable_units(n,batch):\n    if type(n) is not int or type(batch) is not int or batch<=0: raise ValueError('argument')\n    return 0 if n<=0 else (n+batch-1)//batch\ndef quote(n,batch):\n    raise NotImplementedError\n"
        u="def discount_cents(total,bps):\n    if type(total) is not int or type(bps) is not int or total<0 or not 0<=bps<=10000: raise ValueError('argument')\n    return (total*(10000-bps)+5000)//10000\n"
        p3=p1.replace("def quote(n,batch):\n    raise NotImplementedError",f"def quote(n,batch):\n    import utils\n    units=billable_units(n,batch)\n    subtotal=units*{price}\n    total=utils.discount_cents(subtotal,{bps} if units>={threshold} else 0)+({fee} if units else 0)\n    return {{'units':units,'subtotal_cents':subtotal,'total_cents':total,'policy':{tag!r}}}")
        for n in [-5,0,1,2,10,111]:
            for b in [1,3,10]:checks.append(f'app.billable_units({n},{b})=={0 if n<=0 else (n+b-1)//b}')
        checks+=['raises(lambda:app.billable_units(True,2))','raises(lambda:app.billable_units(2,0))'];c1=list(checks)
        for t in [0,1,3,101,9999]:
            for d in [0,5000,3333,10000]:checks.append(f'utils.discount_cents({t},{d})=={(t*(10000-d)+5000)//10000}')
        checks+=['raises(lambda:utils.discount_cents(True,1))','raises(lambda:utils.discount_cents(1,10001))'];c2=list(checks)
        for n in [0,1,(threshold-1)*3,threshold*3,1000]:
            units=(n+2)//3 if n>0 else 0;sub=units*price;total=(sub*(10000-(bps if units>=threshold else 0))+5000)//10000+(fee if units else 0)
            checks.append(f"app.quote({n},3)=={ {'units':units,'subtotal_cents':sub,'total_cents':total,'policy':tag}!r}")
        c3=list(checks);initial="def billable_units(n,batch):\n    return n//batch\ndef quote(n,batch):\n    raise NotImplementedError\n";util_initial='def discount_cents(total,bps):\n    raise NotImplementedError\n'
    elif family=='pagination':
        name=['paginate','encode_cursor and decode_cursor','list_page']
        blocks=['CONTRACT paginate(items,size,offset=0): size and offset are integers excluding bool; size>0, offset>=0. Return (items[offset:offset+size], next_offset), where next_offset is offset+size only if there are more items, else None. Offset beyond end yields ([],None). Invalid arguments raise ValueError.',
                f'CONTRACT encode_cursor(offset): offset nonnegative integer excluding bool; invalid raises ValueError. Return string {prefix!r}+":"+str(offset)+":"+str((offset+{salt})%{mod}). CONTRACT decode_cursor(token): require exactly that prefix and three colon-separated fields; offset/checksum canonical nonnegative decimal strings (no leading zeros except zero), valid checksum. Return offset, otherwise ValueError. Exact prefix={prefix}, salt={salt}, modulus={mod}.',
                f'CONTRACT list_page(items,size,cursor=None): if cursor is None offset=0, otherwise utils.decode_cursor(cursor). Call paginate. Return exactly items, next_cursor (None or utils.encode_cursor(next_offset)), policy={tag!r}. Preserve paginate.']
        p1="def paginate(items,size,offset=0):\n    if type(size) is not int or type(offset) is not int or size<=0 or offset<0: raise ValueError('argument')\n    return (items[offset:offset+size],offset+size if offset+size<len(items) else None)\ndef list_page(items,size,cursor=None):\n    raise NotImplementedError\n"
        u=f"def encode_cursor(offset):\n    if type(offset) is not int or offset<0: raise ValueError('offset')\n    return {prefix!r}+':'+str(offset)+':'+str((offset+{salt})%{mod})\ndef decode_cursor(token):\n    if not isinstance(token,str): raise ValueError('token')\n    parts=token.split(':')\n    if len(parts)!=3 or parts[0]!={prefix!r}: raise ValueError('token')\n    a,b=parts[1:]\n    if not a.isascii() or not b.isascii() or not a.isdigit() or not b.isdigit(): raise ValueError('token')\n    offset=int(a); check=int(b)\n    if str(offset)!=a or str(check)!=b or check!=(offset+{salt})%{mod}: raise ValueError('token')\n    return offset\n"
        p3=p1.replace("def list_page(items,size,cursor=None):\n    raise NotImplementedError",f"def list_page(items,size,cursor=None):\n    import utils\n    offset=0 if cursor is None else utils.decode_cursor(cursor)\n    result,nxt=paginate(items,size,offset)\n    return {{'items':result,'next_cursor':None if nxt is None else utils.encode_cursor(nxt),'policy':{tag!r}}}")
        for count in [0,1,3,7]:
            for off in [0,1,8]:
                items=list(range(count));expected=(items[off:off+2],off+2 if off+2<count else None);checks.append(f'app.paginate({items!r},2,{off})=={expected!r}')
        checks+=['raises(lambda:app.paginate([],True))','raises(lambda:app.paginate([],1,-1))'];c1=list(checks)
        for off in [0,1,11,1000]:
            tok=f'{prefix}:{off}:{(off+salt)%mod}';checks.extend([f'utils.encode_cursor({off})=={tok!r}',f'utils.decode_cursor({tok!r})=={off}'])
        for tok in ['wrong:1:1',f'{prefix}:01:{(1+salt)%mod}',f'{prefix}:1:999',None,True]:checks.append(f'raises(lambda:utils.decode_cursor({tok!r}))')
        checks+=['raises(lambda:utils.encode_cursor(True))','raises(lambda:utils.encode_cursor(-1))'];c2=list(checks)
        for off in [0,2,6,20]:
            items=list(range(7));token=None if off==0 else f'{prefix}:{off}:{(off+salt)%mod}';nxt=off+2 if off+2<7 else None;expected={'items':items[off:off+2],'next_cursor':None if nxt is None else f'{prefix}:{nxt}:{(nxt+salt)%mod}','policy':tag};checks.append(f'app.list_page({items!r},2,{token!r})=={expected!r}')
        c3=list(checks);initial="def paginate(items,size,offset=0):\n    return (items[offset:offset+size],offset+size)\ndef list_page(items,size,cursor=None):\n    raise NotImplementedError\n";util_initial='def encode_cursor(offset):\n    raise NotImplementedError\ndef decode_cursor(token):\n    raise NotImplementedError\n'
    elif family=='records':
        name=['normalize_record','dedupe','summarize']
        blocks=['CONTRACT normalize_record(record): record is dict with id and amount. id must be a nonempty string after stripping outer whitespace; preserve case and leading zeroes. amount may be integer excluding bool, or stripped signed decimal integer string. Reject other types and invalid data using ValueError. Return exactly id and amount; do not mutate input.',
                'CONTRACT dedupe(records): each record has string id and integer seq. Return copies of the record with highest seq per id; on equal seq the LAST record wins. Output sorted by id ascending. Never mutate the input records; preserve all selected fields.',
                f'CONTRACT summarize(records): normalize each raw record using normalize_record; accumulate amounts by id, including negative and zero. Return exactly totals (dict), total_amount (sum), and policy={tag!r}. Empty input gives empty totals and zero. Preserve normalize_record. This does NOT use dedupe; these are monetary deltas, not record revisions.']
        p1="import re\ndef normalize_record(record):\n    if not isinstance(record,dict): raise ValueError('record')\n    key=record.get('id');value=record.get('amount')\n    if not isinstance(key,str) or not key.strip(): raise ValueError('id')\n    if type(value) is int: amount=value\n    elif isinstance(value,str) and re.fullmatch(r'[+-]?[0-9]+',value.strip()): amount=int(value.strip())\n    else: raise ValueError('amount')\n    return {'id':key.strip(),'amount':amount}\ndef summarize(records):\n    raise NotImplementedError\n"
        u="def dedupe(records):\n    selected={}\n    for row in records:\n        if row['id'] not in selected or row['seq']>=selected[row['id']]['seq']: selected[row['id']]=dict(row)\n    return [selected[k] for k in sorted(selected)]\n"
        p3=p1.replace("def summarize(records):\n    raise NotImplementedError",f"def summarize(records):\n    totals={{}}\n    for record in records:\n        row=normalize_record(record);totals[row['id']]=totals.get(row['id'],0)+row['amount']\n    return {{'totals':totals,'total_amount':sum(totals.values()),'policy':{tag!r}}}")
        for value,n in [('2',2),(' -2 ',-2),('+0',0),(2,2)]:checks.append(f"app.normalize_record({ {'id':' 001 ','amount':value}!r})=={ {'id':'001','amount':n}!r}")
        for value in [True,1.5,None,'1.5',''] :checks.append(f"raises(lambda:app.normalize_record({ {'id':'A','amount':value}!r}))")
        checks+=['raises(lambda:app.normalize_record({}))',"raises(lambda:app.normalize_record({'id':' ','amount':1}))"];c1=list(checks)
        datasets=[[],[{'id':'b','seq':1,'v':1},{'id':'a','seq':2,'v':0},{'id':'b','seq':1,'v':2}],[{'id':'x','seq':10,'v':0},{'id':'x','seq':1,'v':7}]]
        for rows in datasets:
            selected={}
            for row in rows:
                if row['id'] not in selected or row['seq']>=selected[row['id']]['seq']:selected[row['id']]=row
            expected=[selected[k] for k in sorted(selected)];checks.append(f'utils.dedupe({rows!r})=={expected!r}')
        checks.append("(lambda rows: (utils.dedupe(rows),rows)==([{'id':'a','seq':1}],[{'id':'a','seq':1}]))([{'id':'a','seq':1}])");c2=list(checks)
        for rows in [[],[{'id':' a ','amount':2},{'id':'a','amount':'-1'},{'id':'b','amount':'0'}]]:
            totals={}
            for row in rows:totals[row['id'].strip()]=totals.get(row['id'].strip(),0)+int(row['amount'])
            checks.append(f"app.summarize({rows!r})=={ {'totals':totals,'total_amount':sum(totals.values()),'policy':tag}!r}")
        checks.append("raises(lambda:app.summarize([{'id':'a','amount':True}]))");c3=list(checks);initial="def normalize_record(record):\n    return dict(record)\ndef summarize(records):\n    raise NotImplementedError\n";util_initial='def dedupe(records):\n    raise NotImplementedError\n'
    else:raise ValueError(family)
    users=[f'Stage 1: Read docs/contract.txt and app.py. Fix only {name[0]} according to its CONTRACT. app.py is the only writable module. Leave later-stage stubs unchanged. Save the code and run public tests after the final change.',
           f'Stage 2: The old contract file has been retired from the filesystem; its original tool observation remains in this session history. Implement {name[1]} in utils.py using the exact archived CONTRACT, including any constants and edge cases. Only utils.py is writable. Preserve stage 1, save and run current public tests. Do not guess missing constants.',
           f'Stage 3: Continue this same session. Implement {name[2]} in app.py using the exact retired CONTRACT, reusing existing helpers as specified. Only app.py is writable. Preserve all prior behavior and run current public tests after the final change.']
    scale={'duration':1,'billing':2,'pagination':3,'records':1}[family]
    return {'id':f'{family}-{fault}','family':family,'seed':seed,'fault':fault,'files':{'app.py':initial,'utils.py':util_initial,'docs/contract.txt':spec_document(seed,blocks,scale),'tests/test_public.py':public(1,family)},'users':users,'public':[public(i,family) for i in [1,2,3]],'hidden':[hidden_script(c) for c in [c1,c2,c3]],'golden':[{'app.py':p1,'utils.py':util_initial},{'app.py':p1,'utils.py':u},{'app.py':p3,'utils.py':u}]}

def cases():
    return [make_case(family,100+f*3+i,fault) for f,family in enumerate(['duration','billing','pagination','records']) for i,fault in enumerate(['normal','transient','outage'])]
