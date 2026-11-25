import fs from 'node:fs/promises'
import path from 'node:path'

export interface User{
    name:string
    sharedKey:string
}

export interface Work{
    time:string
    description:string
}

export const getUsers = (p:string):Promise<User[]>=>fs.readdir(p)
    .then(files => {
        let temp:[string,string,string]=['','','']
        const users = files.map(item=>{
            temp = item.split('_') as [string,string,string]
            return {
                name:temp[1],
                sharedKey:temp[2],
                //dir:item
            }
        }).filter(user=>user.name && user.sharedKey)
        return users
    })


export const getWorks = (p:string):Promise<Work[]>=>fs.readdir(p)
    .then(files => {
        let temp:[string,string]=['','']
        const works = files.map(item=>{
            temp = item.split('_') as [string,string]
            return {
                time:temp[0]||'',
                description:temp[1]||'',
                //dir:item,
                // userimg:`${item}_avatar.jpeg`,
                // img:`${item}_cover.jpeg`,
                // video:`${item}_video.mp4`
            }
        })
        return works;
    })
    .catch(_ex=>{
        return []
    })

export const getUserDirName = (user:User)=>`user_${user.name}_${user.sharedKey}`
export const getWorkDirName = (work:Work)=>{
    return `${work.time}_${work.description}`
}

export const getVideoAssets = (user:User,work:Work,type:'avatar.jpeg'|'video.mp4'|'cover.jpeg'='video.mp4')=>{
    const p = getUserDirName(user)
    const w = getWorkDirName(work)
    return `${p}/post/${w}/${w}_${type}`
}

export const getAllUser = (p:string)=>{
    return getUsers(p)
    .then(users=>{
        return Promise.all(users.map(user=>getWorks(path.join(p,getUserDirName(user),'post')).then(works=>{
            return {
                ...user,
                works
            }
        })))
    })
}
