## hermes tern is installed

Open a Tern pane and run:

```sh
hermes tern
```

**Pull requests (optional).** The PR view reads GitHub with your own token. The plugin never reads another tool's login, so copy your GitHub CLI token into Hermes once per profile:

```sh
hermes config set GITHUB_TOKEN "$(gh auth token)"
```

The chat works without it; only the PR view and its checks need it. For GitHub Enterprise, see the README's Pull requests section.
