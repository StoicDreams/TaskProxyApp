import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// One browser test run at a time on this machine, across every repo that uses this file. Two runs at once starve each
// other of CPU until tests time out, so a second run waits for the first instead. CI runs one repo per machine, so
// it never waits. The lock is a folder, which only one process can create; a lock left by a run that died is taken over.
const LOCK = join(homedir(), '.cache', 'stoic-dreams', 'browser-tests.lock');
const OWNER = join(LOCK, 'owner.json');

const alive = pid => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
};

const ownerOf = () => {
    try {
        return JSON.parse(readFileSync(OWNER, 'utf8'));
    } catch {
        return null;
    }
};

function tryTake() {
    try {
        mkdirSync(LOCK, { recursive: false });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = ownerOf();
        // A folder with no owner yet is a run between creating it and writing its name: give it a moment.
        if (owner && !alive(owner.pid)) rmSync(LOCK, { recursive: true, force: true });
        return false;
    }
    writeFileSync(OWNER, JSON.stringify({ pid: process.pid, cwd: process.cwd(), started: new Date().toISOString() }));
    return true;
}

export default async function machineLock() {
    if (process.env.CI || process.env.PW_NO_LOCK) return undefined;
    mkdirSync(join(homedir(), '.cache', 'stoic-dreams'), { recursive: true });
    let told = false;
    while (!tryTake()) {
        if (!told) {
            const owner = ownerOf();
            console.log(`Waiting for the browser tests running in ${owner?.cwd ?? 'another repo'} to finish (set PW_NO_LOCK=1 to skip this).`);
            told = true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const release = () => {
        if (ownerOf()?.pid === process.pid) rmSync(LOCK, { recursive: true, force: true });
    };
    process.once('exit', release);
    return release;
}
