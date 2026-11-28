import { catalogApi as api, jsonHeaders } from '../catalog-api';
import type { IssueRow } from '../catalog-types';
import { errorMessage, escapeHtml as escape } from '../dom';
import { byId } from '../utils/catalog-elements';
import { issueNames, reviewNames } from '../utils/catalog-markup';
import { optionMarkup as options } from '../utils/format';
import type { useCatalogDialog } from './useCatalogDialog';
import type { ShowToast } from './useToast';

export function useIssueReview(dialog: ReturnType<typeof useCatalogDialog>, showToast: ShowToast, onReviewSaved: () => void) {
    const { modal } = dialog;

    function editReview(row: IssueRow) {
        dialog.open('复核异常', 'review-modal');
        byId('modal-subtitle').textContent = `${issueNames[row.code] ?? row.code} · ${row.detail}`;
        byId('modal-body').innerHTML = `<form id="review-form"><code class="path">${escape(row.path)}</code>
            <label>处理状态<select name="status">${options(reviewNames, row.status)}</select></label>
            <label>备注<textarea name="note" rows="4" maxlength="2000" placeholder="记录核查结果或处理方式">${escape(row.note)}</textarea></label>
            <p id="save-error" role="alert" hidden></p><div class="form-actions"><button type="button" class="secondary" data-dismiss>取消</button><button type="submit" class="primary">保存复核</button></div></form>`;
        byId('review-form').addEventListener('submit', async event => {
            event.preventDefault();
            const version = dialog.version;
            const submit = event.submitter;
            if (submit instanceof HTMLButtonElement) submit.disabled = true;
            const form = new FormData(byId('review-form'));
            try {
                await api(`issues/${encodeURIComponent(row.id)}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(Object.fromEntries(form)) });
                if (version === dialog.version && modal.open) modal.close();
                onReviewSaved();
                showToast('复核已保存');
            } catch (error) {
                if (version === dialog.version && modal.open) {
                    byId('save-error').textContent = errorMessage(error);
                    byId('save-error').hidden = false;
                }
            } finally { if (submit instanceof HTMLButtonElement) submit.disabled = false; }
        });
    }

    return editReview;
}
