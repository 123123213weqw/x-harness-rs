// Re-resolve and validate before activation or input. No path-search fallback:
// a changed/ambiguous target requires a new observation, not a guessed replay.
function safe(f,d) { try { return f(); } catch (_) { return d; } }
function failure(code,message) { return JSON.stringify({ok:false,error:{code,message}}); }
function sameBounds(a,b) {
  return a && b && ['x','y','width','height'].every(k => Number.isFinite(a[k]) && Math.abs(a[k]-b[k])<0.5);
}
function run(argv) {
  const request = JSON.parse(argv[0]);
  const se = Application('System Events');
  const matches = se.applicationProcesses.whose({unixId:request.pid})();
  if (matches.length !== 1) return failure('stale_node','target process changed; observe again');
  const process = matches[0];
  let current,root,insideSheet=false;
  if (request.root_kind === 'window') {
    root = safe(() => process.windows()[request.root_index-1],null);
    if (!root || !safe(() => root.exists(),false)) return failure('stale_node','target window changed; observe again');
    const liveBounds=bounds(root);
    const ids=(request.windows || []).filter(w => w.pid===request.pid && sameBounds(w.bounds,liveBounds));
    if (!request.window_id || ids.length!==1 || ids[0].id!==request.window_id ||
        !sameBounds(liveBounds,request.window_bounds)) return failure('stale_node','target window identity changed or is ambiguous; observe again');
    current=root;
  } else if (request.root_kind === 'menu_bar') {
    current=safe(() => process.menuBars()[request.root_index-1],null);
  } else return failure('stale_node','unsupported accessibility root');
  if (!current || !safe(() => current.exists(),false)) return failure('stale_node','accessibility root changed; observe again');
  for (const index of request.path) {
    current=safe(() => current.uiElements()[index],null);
    if (!current || !safe(() => current.exists(),false)) return failure('stale_node','accessibility path changed; observe again');
    const role=safe(() => current.role(),null);
    if (role==='AXSheet' || role==='AXDialog') insideSheet=true;
  }
  const identity=identityOf(current),expected=request.identity;
  const identityMatches=expected && (root && request.path.length===0
    ? identity.role==='AXWindow' && identity.label===expected.label
    : ['role','subrole','label','identifier'].every(k => identity[k]===expected[k]));
  if (!identityMatches ||
      !sameBounds(bounds(current),request.bounds)) return failure('stale_node','target control changed; observe again');
  if (safe(() => current.enabled(),null)===false) return failure('target_disabled','target control is disabled; observe again');
  // A sheet blocks its parent, but controls inside that sheet remain usable.
  if (root && !insideSheet) {
    const sheets=safe(() => root.sheets(),null);
    if (sheets===null) return failure('stale_node','cannot verify modal state; observe again');
    if (sheets.length) return failure('target_obscured','target window has a modal sheet; observe again');
  }
  if (request.operation==='validate') {
    if (!safe(() => process.frontmost(),false) || (root && request.foreground_window_id!==request.window_id)) return failure('target_obscured','coordinate target is not the foreground window; observe again');
    return JSON.stringify({ok:true});
  }
  if (request.operation==='focus') {
    const focused=current.attributes.byName('AXFocused');
    if (!safe(() => focused.exists(),false)) return failure('stale_node','node does not support focus; observe again');
    process.frontmost=true;
    focused.value=true;
    if (!safe(() => focused.value()===true,false)) return failure('stale_node','target did not accept focus; observe again');
  } else {
    const action=current.actions.byName(request.operation);
    if (!safe(() => action.exists(),false)) return failure('stale_node','node action changed; observe again');
    process.frontmost=true;
    action.perform();
  }
  return JSON.stringify({ok:true,node_id:request.node_id,operation:request.operation,effect_verified:false});
}
