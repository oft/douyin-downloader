import fs from 'node:fs/promises'
import { getAllUser } from "../util/user";

export const write = (d:any)=>{
    return fs.writeFile('./data.json',JSON.stringify(d,null,4),'utf-8')
}

getAllUser('../Downloaded').then(write)