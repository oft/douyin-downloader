import '../util/io-audit-bootstrap.ts';
import path from 'node:path';
import { projectRoot } from '../util/project-paths.ts';
import fs from 'node:fs/promises'
import { getAllUser } from "../util/user";

export const write = (d:any)=>{
    return fs.writeFile(new URL('../data.json', import.meta.url),JSON.stringify(d,null,4),'utf-8')
}

getAllUser(path.join(projectRoot, 'Downloaded')).then(write)
