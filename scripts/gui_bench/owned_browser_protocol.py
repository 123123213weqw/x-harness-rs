"""Protocol reader bound to one probe process, never a successor's queue."""
import json


def read_replies(output, replies):
    try:
        for line in output:
            if line.startswith('BENCH_REPLY '):
                replies.put(json.loads(line[len('BENCH_REPLY '):]))
    finally:
        # This EOF belongs to this exact stream, including during probe restart.
        replies.put(None)
