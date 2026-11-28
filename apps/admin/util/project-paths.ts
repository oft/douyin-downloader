import { fileURLToPath } from 'node:url';

/** Repository root, independent of the working directory used to start the app. */
export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
