// Shared snapshot/action identity rules; the caller supplies safe().
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
// System Events description() can be a localized role description ("group"),
// not an explicit label. Read AXDescription separately for layout groups;
// never whitelist English/localized role strings or discard named groups.
function identityOf(element) {
  const role = clipped(safe(() => element.role(), ''), 80) || 'AXUnknown';
  const subrole = clipped(safe(() => element.subrole(), ''), 80);
  const title = clipped(safe(() => element.title(), ''), 160);
  const name = title ? null : clipped(safe(() => element.name(), ''), 160);
  const explicitDescription = role === 'AXGroup' ? safe(() => {
    const attr=element.attributes.byName('AXDescription');
    return {known:true,value:attr.exists() ? attr.value() : null};
  }, {known:false,value:null}) : {known:true,value:null};
  const description = role === 'AXGroup'
    ? clipped(explicitDescription.value, 160)
    : clipped(safe(() => element.description(), ''), 160);
  const help = title || name || description ? null : clipped(safe(() => element.help(), ''), 160);
  const identifier = clipped(attribute(element, 'AXIdentifier', ''), 160);
  return {role, subrole, label:title || name || description || help || identifier || null,
    description, identifier, layout_label_known:explicitDescription.known};
}
