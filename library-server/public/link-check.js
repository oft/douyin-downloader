export const linkCheckNames = { valid: '正常', unavailable: '不可访问', restricted: '访问受限', invalid: '格式无效', unknown: '待确认' };

export function linkCheckResult(link, job, results) {
    if (['starting', 'running', 'stopping'].includes(job.state) && job.currentLink === link) {
        return { status: 'checking', name: '正在检测…' };
    }
    const result = results.get(link);
    return result ? { ...result, name: linkCheckNames[result.status] } : { status: 'unchecked', name: '未检测' };
}
