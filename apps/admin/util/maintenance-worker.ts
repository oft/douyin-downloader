import './io-audit-bootstrap.ts';
import { inspectEmptyAuthors, importIssueReport, removeEmptyAuthors, removeLinks } from './maintenance.ts';
let text = '';
for await (const chunk of process.stdin) text += chunk;
try {
    const request = JSON.parse(text);
    const data = request.kind === 'import-report' ? await importIssueReport(request.location, request.type, request.page) : request.kind === 'scan' ? await inspectEmptyAuthors(request.location)
        : request.kind === 'authors' ? await removeEmptyAuthors(request.location, request.ids, request.token)
            : await removeLinks(request.location, request.links, request.token);
    process.stdout.write(JSON.stringify({ data }));
} catch (error) {
    const failure = error as Error & { status?: number };
    process.stdout.write(JSON.stringify({ error: failure.message, status: failure.status ?? 409 }));
}
