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
            console.log('worker proc failed', ex);
            return { ok: false, msg: ex };
        }
    }
}

const procs = {
    processFileDiff: async function (data) {
        let lineNumber = 0;
        let lineOld = 0;
        const { added, removed } = procs.parseGitDiff(data.fileDiff || '');
        let result = { old: [], new: [] };
        if (data.fileContent !== undefined) {
            let fileLines = data.fileContent.replace(/\r\n/g, '\n').split('\n');
            while (lineNumber < fileLines.length) {
                let line = fileLines[lineNumber++];
                if (data.isCompare) {
                    if (added[lineNumber] !== undefined) {
                        if (removed[lineOld + 1] !== undefined) {
                            lineOld++;
                            buildLine(result.old, removed[lineOld], lineOld, 'danger');
                        } else {
                            buildLine(result.old, line, ' ', null, true);
                        }
                    } else {
                        lineOld++;
                        if (removed[lineOld] !== undefined) {
                            buildLine(result.old, removed[lineOld], lineOld, 'danger');
                            lineOld++;
                        }
                        buildLine(result.old, line, lineOld);
                    }
                }
                {
                    let theme = added[lineNumber] !== undefined ? 'success' : null;
                    buildLine(result.new, line, lineNumber, theme);
                }
            }
        }

        function buildLine(array, line, lineNumber, theme, fill) {
            let ln = { lineNumber: lineNumber, line: line };
            if (theme) {
                ln.background = `--color-${theme}`;
                ln.color = `--color-${theme}-offset`;
            }
            if (fill) {
                ln.isFiller = true;
                ln.background = `--color-warning`;
                ln.color = `#00000000`;
            }
            array.push(ln);
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


