"use strict"
webui.define("app-page-handler", {
    constructor: (t) => {
        console.log('Page Handler Init', location.pathname);
    },
    attr: [],
    attrChanged: (t, property, value) => {
        switch (property) {
        }
    },
    connected: function (t) { },
    disconnected: function (t) { }
});