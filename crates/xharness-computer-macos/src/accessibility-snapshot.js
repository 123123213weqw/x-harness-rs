// System Events JXA. Read-only; node IDs retain their original window/path.
// A soft deadline returns complete records collected so far. Rust retains an
// independent watchdog for a single Apple Event that never returns.
const budgetReached = {};
let deadline = Infinity;
function safe(f, d) {
  if (Date.now() >= deadline) throw budgetReached;
  try {
    const value = f();
    if (Date.now() >= deadline) throw budgetReached;
    return value;
  } catch (error) {
    if (error === budgetReached) throw error;
    return d;
  }
}
function clipped(value, limit) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return null;
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}
function boolValue(f, fallback) {
  const value = safe(f, fallback);
  return value === null || value === undefined ? fallback : Boolean(value);
}
function attribute(element, name, fallback) {
  return safe(() => element.attributes.byName(name).value(), fallback);
}
function bounds(element) {
  const position = safe(() => element.position(), null);
  const size = safe(() => element.size(), null);
  if (!position || !size) return null;
  const result = {x:Number(position[0]), y:Number(position[1]), width:Number(size[0]), height:Number(size[1])};
  return Object.values(result).every(Number.isFinite) ? result : null;
}
function actionNames(element) {
  return safe(() => element.actions().map(action => clipped(action.name(), 80)).filter(Boolean), []);
}
function safeValue(element, role, subrole) {
  if (role === 'AXSecureTextField' || subrole === 'AXSecureTextField') return '<redacted>';
  if (role === 'AXTextField' || role === 'AXTextArea' || role === 'AXComboBox') return null;
  return clipped(safe(() => element.value(), null), 160);
}
function run(argv) {
  const options = argv.length ? JSON.parse(argv[0]) : {};
  const maxNodes = Math.max(1, Math.min(Number(options.max_nodes) || 220, 600));
  const maxDepth = Math.max(1, Math.min(Number(options.max_depth) || 8, 16));
  const maxVisited = maxNodes * 5;
  const includeNodes = options.include_nodes !== false;
  const start = Date.now();
  deadline = start + Math.max(1, Math.min(Number(options.time_budget_ms) || 8000, 8000));
  const result = {windows:[], nodes:[], truncated:false, visited:0, max_nodes:maxNodes, max_depth:maxDepth, truncation_reasons:[], elapsed_ms:0};
  const roots = [];
  function truncated(reason) {
    result.truncated = true;
    if (!result.truncation_reasons.includes(reason)) result.truncation_reasons.push(reason);
  }
  function full() {
    if (result.nodes.length >= maxNodes) { truncated('node_limit'); return true; }
    if (result.visited >= maxVisited) { truncated('visit_limit'); return true; }
    return false;
  }
  function walk(element, context, parentId, path, depth) {
    if (full()) return;
    if (Date.now() >= deadline) throw budgetReached;
    result.visited += 1;
    if (depth > maxDepth) { truncated('depth_limit'); return; }
    const role = clipped(safe(() => element.role(), ''), 80) || 'AXUnknown';
    const subrole = clipped(safe(() => element.subrole(), ''), 80);
    const title = clipped(safe(() => element.title(), ''), 160);
    const name = clipped(safe(() => element.name(), ''), 160);
    const description = clipped(safe(() => element.description(), ''), 160);
    const help = clipped(safe(() => element.help(), ''), 160);
    const identifier = clipped(attribute(element, 'AXIdentifier', ''), 160);
    const actions = actionNames(element);
    const nodeId = `ax:${context.pid}:${context.root_kind[0]}${context.root_index}:${path.join('.') || 'root'}`;
    const nodeBounds = bounds(element);
    const label = title || name || description || help || identifier || null;
    const visible = boolValue(() => element.visible(), true);
    const emit = role !== 'AXUnknown' || label || actions.length || nodeBounds;
    const nextParent = emit ? nodeId : parentId;
    if (emit) {
      // Do not push a half-read target if the budget expires during a field.
      const node = {
        node_id:nodeId, parent_id:parentId, surface_id:context.surface_id,
        pid:context.pid, root_kind:context.root_kind, root_index:context.root_index,
        path, role, subrole, label,
        description:description && description !== label ? description : null,
        identifier, value:safeValue(element,role,subrole),
        enabled:boolValue(() => element.enabled(),true),
        focused:boolValue(() => element.focused(),false),
        selected:boolValue(() => element.selected(),false), visible,
        bounds:nodeBounds, actions, depth
      };
      result.nodes.push(node);
      if (full()) return;
    }
    const children = safe(() => element.uiElements(), []);
    for (let index=0; index<children.length; index++) {
      walk(children[index], context, nextParent, path.concat([index]), depth+1);
      if (full()) return;
    }
  }
  try {
    const se = Application('System Events');
    // Cache frontmost once per process, rather than querying it in every sort
    // comparator. Enumerate windows before controls so all cheap surfaces can
    // survive a node/time limit in the expensive second phase.
    const processes = safe(() => se.applicationProcesses.whose({visible:true})(), [])
      .map(process => ({process, frontmost:boolValue(() => process.frontmost(),false)}));
    processes.sort((a,b) => Number(b.frontmost)-Number(a.frontmost));
    for (const entry of processes) {
      const process = entry.process;
      const pid = Number(safe(() => process.unixId(),0)) || 0;
      const app = clipped(safe(() => process.name(),''),160) || '';
      const windows = safe(() => process.windows(),[]);
      for (let index=0; index<windows.length; index++) {
        const window = windows[index];
        const windowBounds = bounds(window);
        if (!windowBounds) continue;
        const surfaceId = `mac:${pid}:${index+1}`;
        const windowNodeId = `window:${pid}:${index+1}`;
        const minimized = boolValue(() => window.attributes.byName('AXMinimized').value(),false);
        const info = {
          surface_id:surfaceId, node_id:windowNodeId, app, pid, window_index:index+1,
          title:clipped(safe(() => window.name(),''),240) || '',
          frontmost:entry.frontmost,
          focused:boolValue(() => window.attributes.byName('AXFocused').value(),false),
          minimized, bounds:windowBounds
        };
        result.windows.push(info);
        if (includeNodes && !minimized) roots.push({element:window, context:{pid,root_kind:'window',root_index:index+1,surface_id:surfaceId}, parent:windowNodeId});
      }
      if (includeNodes && entry.frontmost) {
        const menuBars = safe(() => process.menuBars(),[]);
        for (let index=0; index<menuBars.length; index++) roots.push({element:menuBars[index], context:{pid,root_kind:'menu_bar',root_index:index+1,surface_id:`mac:${pid}:menu`}, parent:`application:${pid}`});
      }
    }
    for (const root of roots) {
      if (full()) break;
      if (root.context.root_kind === 'window') {
        const children = safe(() => root.element.uiElements(),[]);
        for (let index=0; index<children.length; index++) {
          walk(children[index],root.context,root.parent,[index],1);
          if (full()) break;
        }
      } else {
        walk(root.element,root.context,root.parent,[],0);
      }
    }
  } catch (error) {
    if (error !== budgetReached) throw error;
    truncated('time_budget');
  }
  result.elapsed_ms = Date.now()-start;
  return JSON.stringify(result);
}
