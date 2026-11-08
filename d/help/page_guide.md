<webui-tabs theme="info" transition-timing="200">
    <webui-button slot="tabs">Editing Pages</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        A page is a list of segments. Each one is a heading, a line break, or a **segment** of markdown, and the page is saved to `.taskproxy/pages` so it is committed with your project.

        - **Edit**: Click the pencil beside a segment. The editor opens on the left and the result updates on the right as you type.
        - **Type**: Choose **segment**, a heading from **h1** to **h6**, or **line break** with the switch at the top. Text carries over when you change the type.
        - **Undo**: Click the arrow below the pencil to throw away the changes and close the editor.
        - **Delete**: Click **Delete** in the editor. The segment comes back if you leave without saving.
        - **Add**: Click **Add** in the top bar to add a segment at the top, or in the bottom bar to add one at the end.
        - **Move**: Drag a segment by its pencil, or focus the pencil and press Alt+Up or Alt+Down.
        - **Title**: Click the page title at the top of the window to change the title and subtitle.
        - **Save**: Click **Save** in the top or bottom bar. Closing a segment's editor does not save the page.

        Content that is not a heading or line break is kept in a segment. When a page opens, any loose content is wrapped in a segment that runs until the next heading, line break, or segment.
        </webui-page-segment>
    </webui-content>

    <webui-button slot="tabs">Markdown</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        Segments are written in markdown. Leave a blank line between paragraphs, lists, and code blocks.

        | Write | To get |
        | --- | --- |
        | `**bold**` or `__bold__` | **bold** |
        | `*italic*` or `_italic_` | *italic* |
        | `~~struck out~~` | ~~struck out~~ |
        | `` `code` `` | `code` |
        | `[Task Proxy](https://www.taskproxy.com)` | a link |
        | `![Logo](https://example.com/logo.png "A title")` | an image, with an optional title |
        | `:rocket:` | :rocket: an emoji, by name |
        | `\*not italic\*` | \*not italic\* |

        **Headings** start with one to six `#` and a space. Give each heading its own segment by choosing **h1** to **h6**, so the page keeps its outline.

        ```md:Headings
        # Page heading
        ## Section
        ### Subsection
        ```

        **Lists** start with `-` or `*` for bullets, or a number and a period. Indent an item to nest it.

        ```md:Lists
        - Install the tools
          - Node.js
          - PowerShell
        - Clone the repo

        1. Build
        2. Test
        3. Release
        ```

        **Quotes** start with `>`, and a line of `---` draws a line across the segment.

        ```md:Quotes and lines
        > Commit early, commit often.

        ---
        ```

        **Tables** use `|` between cells, with a line of dashes under the header.

        ```md:Tables
        | Environment | Url |
        | --- | --- |
        | Dev | https://dev.example.com |
        | Prod | https://example.com |
        ```

        **Code blocks** start and end with three backticks. Name the language after the opening backticks to color the code, and add a colon and a label to title the block. Every code block has a copy button.

        ````md:Code blocks
        ```json:appsettings.json
        { "logging": "debug" }
        ```
        ````
        </webui-page-segment>
    </webui-content>

    <webui-button slot="tabs">Scripts & Variables</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        A code block in `powershell`, `pwsh`, or `ps1` gets a run button. Scripts run in your project's folder, and their output shows in the Terminals drawer. The first time you run a project's scripts, Task Proxy asks whether you trust the project.

        Name the step in the line just above the block, since the run button takes its name from that line.

        ````md:A step with a script
        Install the tools

        ```pwsh
        npm install
        ```
        ````

        **Variables in scripts**: Give a variable a default with `$Name = 'value'`. When a variable named `Name` has a value in the Page, Project, or Global scope, Task Proxy puts that value in its place before the script runs. The code block shows the value it will use, and long values are partly hidden.

        ```pwsh:Variables in a script
        $Branch = 'main'
        $DeployUrl = 'https://dev.example.com'
        git checkout $Branch
        ```

        **Variables in text**: Write a variable's name in capitals with underscores, inside curly braces, to show its value in the page. For example, `{MY_VARIABLE}` shows the value of `my_variable`.

        **Asking for values**: An input bound to a name with `data-bind` makes a Page variable, which scripts on the page can use. Text typed into this input replaces the default in `$Version = '1.0.0'`:

        ```html:An input for a script
        <webui-input-text label="Version" data-bind="Version"></webui-input-text>
        ```

        Use the Variables drawer to manage Project and Global variables, and environments for different sets of values.
        </webui-page-segment>
    </webui-content>

    <webui-button slot="tabs">HTML & Components</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        Segments can hold HTML, including the Web UI components below, mixed with markdown. Put a blank line between a component's tags and markdown inside it.

        ```html:A component holding markdown
        <webui-alert show variant="warning">

        Run **Build** before **Release**.

        </webui-alert>
        ```

        Pages can come from any project you open, so Task Proxy removes scripts, styles, frames, and event attributes such as `onclick` before showing them.

        Choose a component to see how to use it, with live examples you can copy.
        </webui-page-segment>
        <webui-components nohash exclude="app-template webui-alerts webui-app webui-app-config webui-components webui-data-loader webui-dialogs webui-drawer webui-feedback webui-myfi-dev-settings webui-myfi-info webui-myfi-storage-consent webui-nav webui-nav-group webui-openapi webui-page-footer webui-page-help webui-page-not-found webui-page-requires webui-poweredby webui-restrict-to-role webui-site-settings webui-standard-methods webui-stoic-dreams-logo webui-stoic-social-links"></webui-components>
    </webui-content>
</webui-tabs>
