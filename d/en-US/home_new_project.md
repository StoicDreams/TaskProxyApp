<webui-data data-page-title="Add Your First Project" data-page-subtitle="Link Task Proxy to your project folder"></webui-data>

## Let's Connect Your First Project

Great! Your security key is set. Now, let's tell Task Proxy where your first project lives on your computer.

<webui-page-segment>

<app-add-project></app-add-project>

</webui-page-segment>

### Understanding Project References

<webui-page-segment>

* **What it is:** A Project Reference links Task Proxy to a specific folder on your machine. We recommend using the main root folder of your code repository (e.g., the folder containing your `.git` or `.svn` directory).

</webui-page-segment>

<webui-page-segment>

* **What happens:** When you add a project, Task Proxy creates a `.taskproxy` folder inside your chosen project folder.
  * This `.taskproxy` folder stores project-specific configurations, scripts, documentation links, and *default* variable values managed by Task Proxy.
  * Sensitive variable values (your 'secrets') are **not** stored here; they remain encrypted using the security key you just created and are stored securely elsewhere.

</webui-page-segment>

<webui-page-segment>

* **Default Values:** You can set non-sensitive default values for variables within the `.taskproxy` data. These are useful for settings common across a team but can be overridden locally (as secrets) if needed. Never store sensitive information as a default value.

</webui-page-segment>

<webui-page-segment>

* **Existing Projects:** If you select a folder that already contains a `.taskproxy` subfolder, Task Proxy will load the existing project data.

</webui-page-segment>

> NOTE: You are accessing a very early build of this application. Project management features may evolve.

### Change or remove your key

<webui-page-segment>

If you were expecting projects to be loaded but none were, you may have entered the wrong key. You can try entering a different key here.

<webui-quote theme="danger">

NOTE: Once you have set your first project with a new key, any projects set with an old key will be erased.

</webui-quote>

</webui-page-segment>

<app-security-key-setter></app-security-key-setter>
