<script setup lang="ts">
const tabs = [
    ['media', '媒体异常'], ['authors', '无作品作者'], ['links', '链接检查'],
    ['import', '导入差异 / 未归属'], ['diagnostics', '运行诊断'], ['logs', '日志清理'],
] as const;
</script>

<template>
    <div class="cleanup-header"><div><h2>异常处理中心</h2>
            <p class="summary">打开页面仅显示已有结果。扫描、检测和清理均由按钮触发，清理前先确认范围。</p></div><span id="cleanup-lock" class="summary"></span></div>
        <div class="cleanup-tabs" role="tablist" aria-label="异常分类">
            <button v-for="[id, label] in tabs" :key="id" class="secondary" role="tab"
                :aria-selected="id === 'media'" :data-cleanup-tab="id">{{ label }}</button>
        </div>
        <section id="cleanup-media" class="cleanup-section"><div id="cleanup-media-scan-slot"></div>
            <div class="cleanup-actions"><button id="cleanup-local-files">扫描更新本地文件</button><button id="cleanup-local-files-stop" class="secondary" disabled>停止文件扫描</button><span id="cleanup-local-files-status" class="summary">尚未手动扫描</span></div>
            <p class="summary">外部拷贝或移动文件后，手动更新本地文件登记并修复已知作品路径。不删除文件和作品，不访问抖音；日常下载更新不会自动全盘扫描。</p>
            <div class="cleanup-actions"><span id="cleanup-media-selection" class="summary">未选择异常</span><button id="cleanup-delete-works" class="secondary danger" disabled>查看作品清理范围</button><button id="cleanup-resolve" class="secondary" disabled>标记已处理</button><button id="cleanup-ignore" class="secondary" disabled>忽略</button></div>
            <p class="summary">检查缺失媒体、封面、空文件与图集完整性。可勾选下方记录复核，或预览关联作品及文件的清理范围。</p>
        </section>
        <section id="cleanup-authors" class="cleanup-section" hidden>
            <div class="cleanup-actions"><button id="cleanup-author-scan">扫描无作品作者</button><button id="cleanup-author-remove" class="secondary danger" disabled>预览所选作者清理范围</button><span id="cleanup-author-summary" class="summary">尚未扫描</span></div>
            <p class="summary">同时核对当前库、新版历史库和待导入清单。有历史作品、媒体尚缺失或作品仍在待传的作者会保留。</p><div id="cleanup-author-list"></div>
        </section>
        <section id="cleanup-links" class="cleanup-section" hidden>
            <div class="cleanup-actions"><button id="cleanup-links-load" class="secondary">读取本地链接和已有结果</button><button id="cleanup-links-check">开始检测链接</button><button id="cleanup-links-stop" class="secondary" disabled>停止检测</button><button id="cleanup-links-remove" class="secondary danger" disabled>预览所选链接移除范围</button></div>
            <p class="summary">只有点击“开始检测”才访问抖音。访问受限或待确认不等于失效，是否移除由你核对后选择。</p><div id="cleanup-link-status" role="status"></div><div id="cleanup-link-list"></div>
        </section>
        <section id="cleanup-import" class="cleanup-section" hidden>
            <div class="cleanup-actions"><select id="cleanup-import-type" aria-label="导入异常类型"><option value="conflicts">内容 / 版本差异</option><option value="unassigned">未归属文件</option></select><button id="cleanup-import-load">读取已有导入差异</button></div>
            <p class="summary">读取已保存的导入清单，不启动分享、导入或媒体扫描。版本不同需人工核对，不能据此认定损坏。来源分享为只读，未归属文件需在来源实例整理。</p><div id="cleanup-import-list"></div>
        </section>
        <section id="cleanup-diagnostics" class="cleanup-section" hidden>
            <div class="cleanup-actions"><button id="cleanup-diagnostics-refresh" class="primary">刷新运行诊断</button><input id="cleanup-diagnostics-query" type="search" placeholder="按作者、阶段或原因筛选" aria-label="筛选运行诊断"><select id="cleanup-diagnostics-status" aria-label="诊断状态"><option value="all">全部状态</option><option value="failed">失败 / 未完成</option><option value="running">运行中</option><option value="finished">已完成</option></select></div>
            <p class="summary">点击刷新才汇总最近8轮运行日志。默认预算：作者资料20秒、首批作品20秒、历史核对90秒；下载等待不占历史采集预算。历史未取全会保留为待复核，可标记下次更新重新核对。</p><div id="cleanup-diagnostics-current" class="summary"></div><div id="cleanup-diagnostics-summary" class="summary">尚未读取诊断</div><div id="cleanup-diagnostics-slowest"></div><div id="cleanup-diagnostics-list"></div><div id="cleanup-audit-list"></div>
        </section>
        <section id="cleanup-logs" class="cleanup-section" hidden>
            <div class="cleanup-actions"><select id="cleanup-log-days" aria-label="日志清理范围"><option value="0">全部已结束的日志</option><option value="1">1 天前的已结束日志</option><option value="7">7 天前的已结束日志</option><option value="30">30 天前的已结束日志</option></select><button id="cleanup-log-preview" class="secondary">查看日志清理范围</button><span id="cleanup-log-result" class="summary"></span></div>
            <p class="summary">仅清理已结束任务的 I/O 和更新运行日志。保留当前运行任务的所有分卷、服务输出日志和诊断报告；查看范围后确认删除，不自动清理。</p>
        </section>
        <dialog id="cleanup-dialog" class="cleanup-dialog"><h2 id="cleanup-dialog-title"></h2><div id="cleanup-dialog-body"></div><p id="cleanup-dialog-error" class="player-error" hidden></p><div class="form-actions"><button id="cleanup-cancel" class="secondary">取消</button><button id="cleanup-confirm" class="primary danger">确认执行</button></div></dialog>
</template>
