// Host-owned desired vs active permission. No optimistic escalation of live tools.
export function patchPermissionSelection(bytes) {
 let s=bytes.toString();
 if(s.includes('xharness-permission-selection/v1'))return bytes;
 const anchor='function PermissionSelect({ value, locked, command, t }) {';
 if(!s.includes(anchor))throw Error('PermissionSelect anchor changed');
 s=s.replace(anchor,`function permissionFeedback(value) {
            // xharness-permission-selection/v1
            if (!value?.pending) return '';
            const active = value.activeValue ?? '正在准备';
            return '下一轮生效；当前轮：' + active + '。立即收紧请停止当前任务；已有后台任务需单独停止。';
        }
        `+anchor);
 s=s.replace('locked: locked || running,\n\t\t\t\tcommand,','locked,\n\t\t\t\tcommand,');
 s=s.replace('title: current?.description,',"title: pick !== null ? '正在保存权限选择；当前执行权限不变' : permissionFeedback(value) || current?.description,");
 s=s.replace('children: current === void 0 ? displayName(currentValue) : optionLabel(current)', "children: (current === void 0 ? displayName(currentValue) : optionLabel(current)) + (pick !== null ? ' · 保存中' : value.pending ? ' · 下一轮生效' : '')");
 return Buffer.from(s);
}
