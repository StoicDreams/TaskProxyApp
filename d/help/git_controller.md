## Git Controller Help

<webui-tabs theme="info" transition-timing="200">
    <webui-button slot="tabs">Committing & Syncing</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Committing**: Select files to include, exclude, or ignore using the dropdowns. Enter a commit message and click **Commit**.
        - **Syncing**: Click **Sync** to automatically pull remote changes and push your local commits. Enable the **Sync after commit** toggle to automate this immediately following a commit.
        - **Remote Operations**: Use **Fetch** to check for updates, **Pull** to safely merge remote changes, **Push** to send local commits, or **Force Pull** to overwrite all local changes with the remote branch.
        </webui-page-segment>
    </webui-content>
    <webui-button slot="tabs">Branch Management</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Switching Branches**: Locate the target branch in the Branches table and click **Switch**. Uncommitted changes must be stashed or committed first.
        - **Creating Branches**: Click **New** next to an existing branch to branch off of it.
        - **Merging**: Click **Merge** on a target branch to merge its changes into your currently active branch.
        - **Deleting**: Click **Delete** to remove a local branch. This only cleans up your local environment and will **not** delete the branch from the remote repository.
        </webui-page-segment>
    </webui-content>
    <webui-button slot="tabs">Stashing & Reverting</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Stashing**: Click **Stash** to temporarily save your uncommitted modifications and clean your working directory.
        - **Pop Stash**: Click **Pop Stash** to restore the most recently stashed changes back into your working directory.
        - **Revert All**: Click **Revert All** to permanently discard all uncommitted changes, modified tracked files, and untracked additions.
        - **Revert Single File**: Click the trash can icon next to any pending file change to discard modifications for that specific file.
        </webui-page-segment>
    </webui-content>
    <webui-button slot="tabs">Authentication</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Setting a PAT**: Enter your Personal Access Token in the Auth tab to enable remote operations (Push, Pull, Fetch).
        - **Scoping**: Choose **Project Level** to apply the token only to the current project, or **Global Level** to use it across all Task Proxy projects.
        </webui-page-segment>
    </webui-content>
</webui-tabs>
