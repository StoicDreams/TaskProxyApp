<webui-tabs theme="info" transition-timing="200">
    <webui-button slot="tabs">Committing & Syncing</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
            - **Viewing Changes**: Click on a file name in the pending changes list to load a side-by-side diff comparison of the modifications. Use the up and down arrow keys to move through the files. The file list and the comparison scroll separately.
            - **Choosing Files**: Each file starts as **Include**, so it goes into the next commit. Choose **Exclude** to leave it out of this commit, or **Ignore** to always leave it out until you include it again.
            - **Finding Files**: Type in **Filter files** to show only files whose path contains that text. **Toggle All** includes or excludes every file shown, and leaves ignored files alone.
            - **Committing**: Enter a commit message and click **Commit**. **Files to Commit** and **Lines Changed** show what the commit will contain.
            - **Running a Script First**: Choose a PowerShell script in your project under **Run Before Commit**, such as one that builds, tests, or updates version numbers. Its parameters show below it, with a toggle for each switch, a list for each set of choices, and a field for the rest. Task Proxy remembers the script and values for each repo. When you commit, the script runs first in the Terminals panel, and the file list refreshes to show what it changed. If the script fails, writes an error, or a command in it fails, nothing is committed and its output stays open. If it succeeds, the panel closes and the commit goes ahead, including the files the script changed. While it runs, **Cancel** beside it stops it, and stopping it in the Terminals panel does the same, so nothing is committed. Choose **Nothing** to stop running a script.
            - **Syncing**: Click **Sync** to automatically pull remote changes and push your local commits. Enable the **Sync after commit** toggle to automate this immediately following a commit.
            - **Queueing Commits**: Turn on **Queue** and each commit waits its turn, so commits run one at a time, in the order you made them. A queued commit keeps the message, files, script, and Sync after commit choice it was made with. A queued commit's script runs in the project it was made in, even when another project is open by then. A repo with a commit waiting shows **Currently Queued**, and **Cancel Queue** takes it out. The **Queue** tab lists every queued and running commit, in every project, with how the recent ones ended. The queue lasts until Task Proxy closes.
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
    <webui-button slot="tabs">AI</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Write with AI**: With AI on for Git commit messages (Settings, **AI**), **Write with AI** under the message writes it from the files you include, following your instructions. Change it as you like before committing.
        - **Review**: With AI on for code reviews, a **Review** tab sits beside Commit. Review the changes included for the next commit, or the entire project, and add what to look for this time. A large review is done in parts and joined into one report. It keeps going while you work on other pages or projects, and the tab shows it still working when you come back.
        - **The report**: Kept with the project, through other pages, projects, and restarts, until you **Clear** it or review that repo again. Copy it, or **Save as Page** to keep it in the project's navigation under **Reviews**.
        </webui-page-segment>
    </webui-content>
</webui-tabs>
