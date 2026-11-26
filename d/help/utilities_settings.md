<webui-tabs theme="info" transition-timing="200">
    <webui-button slot="tabs">App Updates</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Checking for Updates**: Click **Check for Updates** to query the server for the latest version.
        - **Installing**: If an update is available, the **Install Updates** button will become active. Clicking it will download the update and automatically restart Task Proxy to apply the new version.
        - **Version Info**: Your current application version is always displayed next to the update controls.
        - **Automatic checks**: Turn on **Check for app and plugin updates every 6 hours**, and the Updates icon at the top, left of Save, checks on its own. When it finds updates, the icon changes and shows how many.
        - **The Updates icon**: Click it any time to check Task Proxy and your installed plugins. It says when there are none; otherwise it lists them, and **Apply Updates** updates the plugins first, then Task Proxy, which restarts.
        </webui-page-segment>
    </webui-content>
    
    <webui-button slot="tabs">Icons & Emojis</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Global Access**: Open **Tools**, the toolbox at the top right, and choose its **Icons & Emojis** tab, from anywhere in the application.
        - **Search**: Use the search bar to filter through standard emojis and integrated Web UI icons.
        - **Integration**: When using tools like the **Nav Manager**, opening this drawer and selecting an icon will automatically assign it to the currently selected page or folder.
        </webui-page-segment>
    </webui-content>

    <webui-button slot="tabs">Performance</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **What it limits**: Settings' **Performance** tab limits the scripts Task Proxy runs, in the Terminal Manager, from pages, and favorites, along with everything they start. Scripts opened in a separate terminal window are not limited.
        - **Priority**: **Low** runs scripts below your other programs. **Lowest** gives them only CPU time nothing else wants.
        - **CPU threads**: Keeps scripts to some of the computer's threads. Tools that size themselves to the computer, such as cargo, start fewer jobs. macOS can only lower priority.
        - **When it applies**: To scripts started after a change. A script already running keeps the limits it started with.
        </webui-page-segment>
    </webui-content>

    <webui-button slot="tabs">AI</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Providers**: Settings' **AI** tab has its own tabs, starting with **Providers**, where each provider you add gets a tab. **Add Provider** asks what you want to use: a subscription you already have, through Claude Code, Codex (ChatGPT), GitHub Copilot, Cursor, or Qwen Code; Ollama or LM Studio for free models on this computer; an API key from OpenAI, Anthropic, Google Gemini, Mistral, xAI, DeepSeek, Groq, Cerebras, Together AI, Fireworks AI, or OpenRouter; your company's Azure OpenAI, AWS Bedrock, or Google Vertex AI; or, for those who know how, another server or command. Each choice shows the steps to set it up, with a button to open each site, and each command it needs shown with a **Run** button that runs it in the Terminal Manager, where you can watch it and answer what it asks. Each asks only for what it needs, such as which Claude models to use or whether Ollama is on this computer. API keys stay on this computer and are never shown again. Changes to providers are kept only once you choose **Save Providers**: until then a warning says they aren't saved, and **Discard Changes** goes back to what is saved. Leaving Settings keeps them until you close Task Proxy.
        - **Models**: A server's models are listed once it is saved, and again with **Refresh Models**. Uncheck any you don't want to choose from. Every provider's models show together wherever a model is chosen. **Test** checks the provider answers.
        - **Use AI For**: Turn on Git commit messages, code reviews, pages, scripts, or importing markdown files. Each shows a **Write with AI** button, or **Review** or **Suggest with AI**, where it is used.
        - **Default Models**: Set globally, or for this project, for everything or for each use. Each button starts on the most specific one set, and you can pick another for one request.
        - **Instructions**: A tab for the instructions shared by every request, and one for each use, such as commit messages. Each shows the built-in instructions Task Proxy always sends first (on **Shared**, what every request is told about Task Proxy and the project's `.taskproxy` folder: its pages, navigation, variables, and scripts, and how a page's PowerShell blocks run), then a global box, for every project, and one for this project. What you write adds to the built-in instructions, never replaces them. For each tab, this project's box is used in place of the global box when it has text; when it is empty, the global box is used. An empty box adds nothing; the grey text in an empty box is only an example. Edit them here, or from the book button beside each Write with AI button.
        - **What is sent**: What you are working on, with the instructions: the included files' changes, or the whole project for a project review; the page or script being edited; or the files being imported. Ollama and LM Studio keep it on this computer. The subscription tools, the API providers, and the cloud providers send it to their servers. Codex, GitHub Copilot, Cursor, and Qwen Code can also read files in the project, as Claude Code can with Look at the project on, and send what they read.
        </webui-page-segment>
    </webui-content>
</webui-tabs>
