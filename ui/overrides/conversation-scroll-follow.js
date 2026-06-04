// A scroll event can be caused by native scroll anchoring or a transcript
// replacement, not just by the reader. In particular, compaction can shrink
// the document while the model is already preparing its next message.
function xhScrollFollowAtBottom(currentAtBottom, scrollTop, floor, observedTop, readerInputRecent) {
  const moved = Math.abs(scrollTop - Math.min(observedTop, floor)) > 0.5;
  return moved && readerInputRecent ? floor - scrollTop <= 25 : currentAtBottom;
}
