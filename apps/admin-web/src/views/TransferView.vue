<template>
    <div class="transfer-layout">
        <section class="transfer-panel" aria-labelledby="sharing-title">
            <header><span class="transfer-eyebrow">从本机分享</span><h2 id="sharing-title">分享资料库</h2>
            <p class="summary">按需开放只读服务，其他实例凭地址和分享码读取。停止分享不会删除资料。</p></header>
            <form id="share-form" class="transfer-form">
                <label>分享范围<select id="share-scope"><option value="all">全部作者和作品</option><option value="authors">选择作者</option><option value="works">指定作品 ID</option></select></label>
                <label id="share-authors-field" hidden>选择作者<select id="share-authors" multiple size="6" aria-label="选择分享的作者"></select><small>可多选；仅分享所选作者的链接和本地作品。</small></label>
                <label id="share-works-field" hidden>作品 ID<textarea id="share-works" rows="3" placeholder="每行一个作品 ID，也可用逗号分隔"></textarea></label>
                <label class="transfer-check"><input id="share-history" type="checkbox" checked>包含清理前新版库中仍有文件的作品</label>
                <small class="summary">用于补全保留的音乐、图片及其他版本；不读取旧版 Release 数据库。</small>
                <div class="transfer-inline"><label>空闲后关闭（分钟）<input id="share-idle" type="number" min="1" max="1440" value="15"></label>
                    <label>分享端口<input id="share-port" type="number" min="0" max="65535" value="0"><small>0 表示自动分配</small></label></div>
                <div class="form-actions"><button id="share-start" type="submit">启动分享</button><button id="share-stop" type="button" class="secondary" disabled>停止分享</button></div>
            </form>
            <div id="share-status" class="transfer-status" role="status"></div>
            <div id="share-access" class="transfer-access" hidden><label>分享地址<select id="share-address"></select></label>
                <label>临时分享码<input id="share-code" readonly autocomplete="off" spellcheck="false"></label>
                <button id="share-copy" class="secondary" type="button">复制地址和分享码</button>
                <small class="summary">请在可信局域网使用；关闭服务后分享码失效，正在传输时不会因空闲超时关闭。</small></div>
        </section>
        <section class="transfer-panel" aria-labelledby="import-title">
            <header><span class="transfer-eyebrow">合并到本机</span><h2 id="import-title">从其他实例导入</h2>
                <p class="summary">以本地为主：已有的不重复导入，只新增和补齐缺失文件，不覆盖本地资料。</p></header>
            <form id="import-form" class="transfer-form">
                <label>分享服务地址<input id="import-address" type="url" placeholder="http://192.168.1.10:12345" required autocomplete="off"></label>
                <label>分享码<input id="import-code" type="password" autocomplete="off" spellcheck="false" required placeholder="填写分享端显示的临时分享码"></label>
                <label class="transfer-check"><input id="import-links" type="checkbox" checked>将新增、已关联作者的链接加入下载配置</label>
                <small class="summary">无链接作者可正常导入；不会为其生成链接，也不会恢复本地已禁用的链接。</small>
                <div class="form-actions"><button id="import-preview" type="submit">读取清单 / 查看差异</button>
                    <button id="import-start" type="button" class="secondary" disabled>导入缺失内容</button>
                    <button id="import-stop" type="button" class="secondary" disabled>停止</button></div>
            </form>
            <div id="import-status" class="transfer-status" role="status"></div>
            <div id="import-preview-result"></div>
        </section>
    </div>
</template>
