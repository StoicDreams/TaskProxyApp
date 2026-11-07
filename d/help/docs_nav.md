<webui-tabs theme="info" transition-timing="200">
    <webui-button slot="tabs">Docs Manager</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Editing Standard Docs**: Use the file dropdown to load existing markdown files from your project (such as `readme.md` or files within a `/docs` directory).
        - **Live Rendering**: The view automatically renders the markdown to HTML below the editor as you type.
        - **Saving**: Click **Save** to persist changes, or **Reset** to discard unsaved modifications and reload the file from disk.
        </webui-page-segment>
    </webui-content>
    
    <webui-button slot="tabs">Nav Manager</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Organizing Pages**: Click **Add Page** to create a new custom page layout, or **Add Folder** to organize your pages hierarchically.
        - **Editing Navigation**: Select a page or folder in the preview list to rename it or change its icon using the integrated Icon Search component.
        - **Reordering**: Drag and drop items in the navigation list to reorder them or nest pages inside folders.
        - **Committing Changes**: Click **Save** to apply the new navigation structure, or **Cancel** to revert any unsaved drag-and-drop operations.
        </webui-page-segment>
    </webui-content>

    <webui-button slot="tabs">Page Editor</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Modular Segments**: Custom pages are built using segmented blocks (`<app-markdown-segment>`). Click **Add** to insert a new block.
        - **Live Editing**: Click the pencil icon on a segment to enter edit mode. You can write standard markdown or use Web UI components directly in the block.
        - **Data Binding**: Any variables defined in your Project or Global scopes (or explicitly listed via `data-bind`) are dynamically injected when the page renders.
        - **Reordering & Saving**: Drag segments by their handles to reorder content, and click **Save** in the top or bottom toolbar to commit the full page layout.
        </webui-page-segment>
    </webui-content>
</webui-tabs>
