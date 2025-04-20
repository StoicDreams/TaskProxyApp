"use strict"
{
    const notFound = `
    ## Not Found

    The page you were looking for was not found.
    `;
    let comp = null;
    function loadProject(project) {

    }
    function setMarkdown(markdown) {
        comp.innerHTML = webui.applyAppDataToContent(markdown);
    }
    webui.define("app-page-handler", {
        constructor: (t) => {
            comp = t;
            webui.log('Page Handler Init - %o', location.pathname);
        },
        connected: function (t) {
            let project = webui.getData('app-current-project');
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
