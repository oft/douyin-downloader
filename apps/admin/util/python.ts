import { fileURLToPath } from 'node:url';
import { createPythonBridge } from '@zqdouyin/python-bridge';
import { projectRoot } from './project-paths.ts';

export function createAdminPythonBridge() {
    return createPythonBridge(projectRoot, fileURLToPath(new URL('../scripts/', import.meta.url)));
}
