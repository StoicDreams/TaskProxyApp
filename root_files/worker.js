"use strict";

onmessage = async (msg) => {
    if (!msg.isTrusted) return;
    let data = JSON.parse(msg.data);
    let result = await processMessage(data.run, data.data);
    let response = { id: data.id, message: result };
    postMessage(JSON.stringify(response));
};

async function processMessage(run, data) {
    if (!run) return { ok: false, msg: 'Missing run' };
    let proc = procs[run];
    if (typeof proc === 'function') {
        try {
            return { ok: true, msg: await proc(data) };
        } catch (ex) {
            console.error('worker proc failed', ex);
            return { ok: false, msg: ex };
        }
    }
}

const procs = {
    processFileDiff: async function (data) {
        const { added, removed } = procs.parseGitDiff(data.fileDiff || '');
        let result = { old: [], new: [] };
        if (data.fileContent !== undefined) {
            let fileLines = data.fileContent.replace(/\r\n/g, '\n').split('\n');
            if (data.change === 'Add') {
                for (let i = 0; i < fileLines.length; i++) {
                    result.new.push({ lineNumber: i + 1, line: fileLines[i] });
                }
            } else if (data.change === 'Delete') {
                for (let i = 0; i < fileLines.length; i++) {
                    result.old.push({ lineNumber: i + 1, line: fileLines[i] });
                }
            } else {
                for (let i = 0; i < fileLines.length; i++) {
                    result.new.push({ lineNumber: i + 1, line: fileLines[i] });
                }
                let newIdx = 0;
                let oldLineNum = 1;
                while (newIdx < fileLines.length || removed[oldLineNum] !== undefined) {
                    if (removed[oldLineNum] !== undefined) {
                        result.old.push({ lineNumber: oldLineNum, line: removed[oldLineNum] });
                        oldLineNum++;
                        continue;
                    }
                    if (newIdx < fileLines.length) {
                        let currentNewLineNum = newIdx + 1;
                        if (added[currentNewLineNum] !== undefined) {
                            newIdx++;
                            continue;
                        }
                        result.old.push({ lineNumber: oldLineNum, line: fileLines[newIdx] });
                        oldLineNum++;
                        newIdx++;
                    }
                }
            }
        }
        return result;
    },
    parseGitDiff: function (diffText) {
        const added = {};
        const removed = {};
        const lines = diffText.split("\n");
        let oldLineNum = 0;
        let newLineNum = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Match hunk header like: @@ -1,5 +1,6 @@
            const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunkMatch) {
                oldLineNum = parseInt(hunkMatch[1], 10);
                newLineNum = parseInt(hunkMatch[2], 10);
                continue;
            }
            if (line.startsWith("+") && !line.startsWith("+++")) {
                added[newLineNum] = line.slice(1);
                newLineNum++;
            } else if (line.startsWith("-") && !line.startsWith("---")) {
                removed[oldLineNum] = line.slice(1);
                oldLineNum++;
            } else {
                // Context line, increment both
                oldLineNum++;
                newLineNum++;
            }
        }
        return { added, removed };
    }
};
