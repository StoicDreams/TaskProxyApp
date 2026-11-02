<webui-data data-page-title="Welcome to Task Proxy!" data-page-subtitle="Let's get your security set up"></webui-data>

## Secure Your Task Proxy Setup

<webui-page-segment>

Welcome! The first step is creating your **Security Key**.

Think of this key as a master password. It's essential because Task Proxy uses it to encrypt and protect any sensitive information (like passwords or API keys) you store in your variables.

Task Proxy utilizes your operating system's native secure credential manager to safely store this key so you don't have to enter it every time you open the app.

</webui-page-segment>

### Key Requirements & Generation

<webui-page-segment>

- **Length**: Your key must be at least 20 characters long to ensure strong AES-256 encryption.
- **Generation**: Click the **Generate Key** button to automatically create a cryptographically secure, random string.
- **Deletion**: You can delete the key from your system later. Doing so only removes it from your OS keychain; your encrypted project data remains intact, but you will need to re-enter the exact same key to access it again.

</webui-page-segment>

### Important: Back Up Your Key!

<webui-page-segment>

We strongly recommend saving a copy of your Security Key somewhere safe, like a password manager. This backup is crucial if:
- Your key gets removed from your system's storage.
- You need to move your Task Proxy data to a new computer.

</webui-page-segment>

### Ready to create your key?

<app-security-key-setter></app-security-key-setter>
