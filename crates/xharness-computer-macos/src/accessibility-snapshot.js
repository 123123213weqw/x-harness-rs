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
function actionNames(element, fallback = []) {
  return safe(() => element.actions().map(action => clipped(action.name(), 80)).filter(Boolean), fallback);
}
function safeValue(element, role, subrole) {
  if (role === 'AXSecureTextField' || subrole === 'AXSecureTextField') return '<redacted>';
  if (role === 'AXTextField' || role === 'AXTextArea' || role === 'AXComboBox') return null;
  return clipped(safe(() => element.value(), null), 160);
}
function run(argv) {
  const options = argv.length ? JSON.parse(argv[0]) : {};
  const maxNodes = Math.max(1, Math.floor(Math.min(Number(options.max_nodes) || 220, 600)));
  const maxDepth = Math.max(1, Math.floor(Math.min(Number(options.max_depth) || 8, 16)));
  const maxVisited = maxNodes * 5;
  const maxRawDepth = 64;
  const search = {policy:'semantic_breadth_first', depth_metric:'semantic',
    max_raw_depth:maxRawDepth, max_visited:maxVisited, max_pending:maxVisited,
    peak_pending:0, transparent_layout_nodes:0, compressed_layout_nodes:0};
  const includeNodes = options.include_nodes !== false;
  const start = Date.now();
  deadline = start + Math.max(1, Math.min(Number(options.time_budget_ms) || 8000, 8000));
  const totalDeadline = deadline;
  let inventoryDeadline = false;
  const result = {windows:[], nodes:[], truncated:false, visited:0, max_nodes:maxNodes, max_depth:maxDepth, truncation_reasons:[], elapsed_ms:0};
  result.search = search;
  const region = options.region || null;
  result.scope = includeNodes ? (region ? 'intersecting_windows' : 'frontmost_windows') : 'windows_only';
  result.inventory_complete = false;
  function inRegion(rect) {
    return !region || (rect.x < region.x + region.width && rect.x + rect.width > region.x &&
      rect.y < region.y + region.height && rect.y + rect.height > region.y);
  }
  function truncated(reason) {
    result.truncated = true;
    if (!result.truncation_reasons.includes(reason)) result.truncation_reasons.push(reason);
  }
  function withBudget(milliseconds, reason, work) {
    const previous = deadline;
    deadline = Math.min(previous, Date.now() + milliseconds);
    try {
      work();
    } catch (error) {
      // A sub-budget may discard only its unfinished optional record. Never
      // swallow the independent overall deadline or any other script error.
      if (error !== budgetReached || Date.now() >= totalDeadline) throw error;
      truncated(reason);
    } finally {
      deadline = previous;
    }
  }
  function full() {
    if (result.nodes.length >= maxNodes) { truncated('node_limit'); return true; }
    if (result.visited >= maxVisited) { truncated('visit_limit'); return true; }
    return false;
  }
  function visitRoot(root) {
    // FIFO within each semantic level, not recursive descent into one branch.
    // Raw paths always retain the original indices used by native input.
    const levels = Array.from({length:maxDepth+1}, () => ({items:[],head:0}));
    let pending = 0;
    function enqueue(element, parentId, path, depth) {
      if (depth > maxDepth) { truncated('depth_limit'); return; }
      if (path.length > maxRawDepth) { truncated('raw_depth_limit'); return; }
      if (pending >= search.max_pending) { truncated('queue_limit'); return; }
      levels[depth].items.push({element,parentId,path,depth});
      pending++;
      search.peak_pending = Math.max(search.peak_pending,pending);
    }
    function childrenOf(element) {
      const children = safe(() => element.uiElements(), null);
      if (children === null) truncated('children_unavailable');
      return children;
    }
    function enqueueChildren(children, parentId, path, depth) {
      if (!children) return;
      for (let index=0; index<children.length; index++) {
        if (depth > maxDepth) { truncated('depth_limit'); break; }
        if (path.length >= maxRawDepth) { truncated('raw_depth_limit'); break; }
        if (pending >= search.max_pending) { truncated('queue_limit'); break; }
        enqueue(children[index],parentId,path.concat([index]),depth);
      }
    }
    if (full()) return;
    if (root.context.root_kind === 'window') {
      enqueueChildren(childrenOf(root.element),root.parent,[],1);
    } else {
      enqueue(root.element,root.parent,[],0);
    }
    while (pending && !full()) {
      let bucket;
      for (const candidate of levels) {
        if (candidate.head < candidate.items.length) { bucket=candidate; break; }
      }
      const task = bucket.items[bucket.head];
      bucket.items[bucket.head++] = null; // release processed native references
      pending--;
      if (Date.now() >= deadline) throw budgetReached;
      result.visited++;
      const {element,parentId,path,depth} = task;
      const context = root.context;
      const role = clipped(safe(() => element.role(), ''), 80) || 'AXUnknown';
      const subrole = clipped(safe(() => element.subrole(), ''), 80);
      const title = clipped(safe(() => element.title(), ''), 160);
      const name = title ? null : clipped(safe(() => element.name(), ''), 160);
      const description = clipped(safe(() => element.description(), ''), 160);
      const help = title || name || description ? null : clipped(safe(() => element.help(), ''), 160);
      const identifier = clipped(attribute(element, 'AXIdentifier', ''), 160);
      const label = title || name || description || help || identifier || null;
      const readActions = actionNames(element,null);
      const actions = readActions || [];
      let children;
      let value, focused, selected;
      let cachedState = false;
      let transparentLayout = false;
      // Only anonymous, non-focus/selection/value-bearing layout
      // groups get zero semantic cost. Only inert single-child wrappers disappear.
      // Meaningful subroles and interaction actions are preserved. A generic
      // context-menu action keeps its original target record and raw path.
      if (context.root_kind === 'window' && role === 'AXGroup' && !subrole &&
          !label && !identifier && readActions !== null &&
          actions.every(action => action === 'AXScrollToVisible' || action === 'AXShowMenu')) {
        children = childrenOf(element);
        if (children && children.length > 0) {
          value = safeValue(element,role,subrole);
          focused = boolValue(() => element.focused(),false);
          selected = boolValue(() => element.selected(),false);
          cachedState = true;
          if (value === null && !focused && !selected) {
            search.transparent_layout_nodes++;
            transparentLayout = true;
            // A context-menu action is still a real target: keep its record,
            // but do not let this anonymous layout layer spend semantic depth.
            if (children.length === 1 && !actions.includes('AXShowMenu')) {
              search.compressed_layout_nodes++;
              enqueueChildren(children,parentId,path,depth);
              continue;
            }
          }
        }
      }
      const nodeId = `ax:${context.pid}:${context.root_kind[0]}${context.root_index}:${path.join('.') || 'root'}`;
      const nodeBounds = bounds(element);
      const visible = boolValue(() => element.visible(),true);
      const emit = role !== 'AXUnknown' || label || actions.length || nodeBounds;
      if (emit) {
        // Never publish a target whose metadata read crossed a soft deadline.
        const node = {
          node_id:nodeId, parent_id:parentId, surface_id:context.surface_id,
          pid:context.pid, root_kind:context.root_kind, root_index:context.root_index,
          path, role, subrole, label,
          description:description && description !== label ? description : null,
          identifier, value:cachedState ? value : safeValue(element,role,subrole),
          enabled:boolValue(() => element.enabled(),true),
          focused:cachedState ? focused : boolValue(() => element.focused(),false),
          selected:cachedState ? selected : boolValue(() => element.selected(),false),
          visible, bounds:nodeBounds, actions,
          depth:path.length, semantic_depth:depth
        };
        result.nodes.push(node);
        if (full()) break;
      }
      // Secure input descendants must not reveal text through child labels.
      if (role === 'AXSecureTextField' || subrole === 'AXSecureTextField') continue;
      if (children === undefined) children = childrenOf(element);
      enqueueChildren(children,emit ? nodeId : parentId,path,depth + (transparentLayout ? 0 : 1));
    }
    full();
  }

  try {
    const se = Application('System Events');
    // Two batched process queries, not one Apple Event per process just to
    // discover the foreground app. Read its controls before background window
    // metadata. window/list remains the explicit inventory-only path. Partial
    // inventories are never proof that another window is absent.
    const foreground = safe(() => se.applicationProcesses.whose({frontmost:true})(), []);
    const background = safe(() => se.applicationProcesses.whose({visible:true,frontmost:false})(), []);
    const processes = foreground.map(process => ({process,frontmost:true}))
      .concat(background.map(process => ({process,frontmost:false})));
    const seen = new Set();
    for (const entry of processes) {
      if (includeNodes && !region && !entry.frontmost && !inventoryDeadline) {
        // Default observations need the active app, not every background app's
        // controls. Cap the best-effort background inventory independently;
        // window/list retains the full inventory budget.
        deadline = Math.min(totalDeadline, Date.now() + 1000);
        inventoryDeadline = true;
      }
      const process = entry.process;
      const pid = Number(safe(() => process.unixId(),0)) || 0;
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
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
        if (includeNodes && !minimized && inRegion(windowBounds) && (entry.frontmost || region)) {
          visitRoot({element:window, context:{pid,root_kind:'window',root_index:index+1,surface_id:surfaceId}, parent:windowNodeId});
        }
      }
      if (includeNodes && entry.frontmost && !region && !full()) {
        // Menus are useful secondary targets, but a large hidden submenu tree
        // must not consume every remaining millisecond after window controls.
        withBudget(750, 'menu_budget', () => {
          const menuBars = safe(() => process.menuBars(),[]);
          for (let index=0; index<menuBars.length; index++) visitRoot({element:menuBars[index], context:{pid,root_kind:'menu_bar',root_index:index+1,surface_id:`mac:${pid}:menu`}, parent:`application:${pid}`});
        });
      }
    }
    result.inventory_complete = true;
  } catch (error) {
    if (error !== budgetReached) throw error;
    truncated(inventoryDeadline && deadline < totalDeadline ? 'window_inventory_budget' : 'time_budget');
  }
  result.elapsed_ms = Date.now()-start;
  return JSON.stringify(result);
}
