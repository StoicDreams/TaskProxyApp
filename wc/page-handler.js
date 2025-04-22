"use strict"
{
    const notFound = `
    ## Not Found

    The page you were looking for was not found.
    `;
    let comp = null;
    let markdown = '';
    let myId = '';
    let myFile = '';
    async function loadProject(project) {
        myId = location.pathname.substring(1);
        myFile = `pages/${myId}.md`;
        console.log('Page Handler - load project %o - %o', myId, myFile);
        let md = await webui.proxy.getProjectFile(myFile, err => { webui.log.warn('getProjectFile:%o', err); });
        console.log('md', md);
        if (!md) {
            md = '';
            console.log('save file %o', myFile);
            await webui.proxy.saveProjectFile(myFile, md);
        }
        setMarkdown(md);
    }
    function setMarkdown(md) {
        markdown = md;
        comp.innerHTML = webui.applyAppDataToContent(markdown);
    }
    webui.define("app-page-handler", {
        constructor: (t) => {
            comp = t;
            webui.log('Page Handler Init - %o', location.pathname);
        },
        connected: function (t) {
            let project = webui.getData('app-current-project');
            console.log('Page Handler - project %o', project);
            if (project && project.value) {
                loadProject(project);
            } else {
                setMarkdown(notFound);
            }
        },
        disconnected: function (t) { },
        loadProject: function (project) {

        }
    });
}
