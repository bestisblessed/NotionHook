const core = require("@actions/core");
const github = require("@actions/github");
const { Client } = require("@notionhq/client");
const { Octokit } = require("@octokit/core");
const { restEndpointMethods } = require("@octokit/plugin-rest-endpoint-methods");

async function createCommit(notion, commits) {
  let fileFormat = core.getInput("files_format");
  if (core.getInput("token") === "") fileFormat = "none";

  // Only fetch files when needed
  let files = "";
  if (fileFormat === "text-list") {
    files = await getFiles();
  }

  for (const commit of commits) {
    const array = commit.message.split(/\r?\n/);
    const title = array.shift();
    const description = array.join(' ');

    // search for a page in the Notion database "Tasks" given the task name
    const task = commit.message.includes("atnt:")
      ? commit.message.substring(commit.message.indexOf("atnt:") + 6)
      : "";
    const page = notion.pages.filter(
      (page) => page.properties.title === task
    )[0] || {};

    // Build optional files block
    let filesBlock;
    switch (fileFormat) {
      case "text-list":
        filesBlock = {
          object: "block",
          type: "toggle",
          toggle: {
            text: [
              { type: "text", text: { content: "Files" } }
            ],
            children: [
              {
                object: "block",
                type: "paragraph",
                paragraph: {
                  text: [{ type: "text", text: { content: files } }]
                }
              }
            ]
          }
        };
        break;
      case "none":
        core.info("No file will be listed");
        break;
      default:
        core.setFailed(
          "Other files list types not supported or file type not specified."
        );
        break;
    }

    // Create the page in Notion
    await notion.pages.create({
      parent: { database_id: core.getInput("notion_database") },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title } }]
        },
        task: { relation: [{ id: page.id || "" }] },
        [core.getInput("commit_url")]: { url: commit.url },
        [core.getInput("commit_id")]: {
          rich_text: [{ type: "text", text: { content: commit.id } }]
        },
        [core.getInput("commit_description")]: {
          rich_text: [{ type: "text", text: { content: description } }]
        },
        [core.getInput("commit_project")]: {
          multi_select: [{ name: github.context.repo.repo }]
        }
      },
      children: [
        { object: "block", type: "paragraph", paragraph: { text: [{ type: "text", text: { content: description } }] } },
        // include filesBlock only if defined
        ...(filesBlock ? [filesBlock] : [])
      ]
    });
  }
}

(async () => {
  try {
    const notion = new Client({ auth: core.getInput("notion_secret") });
    await createCommit(notion, github.context.payload.commits);
  } catch (error) {
    core.setFailed(error.message);
  }
})();

async function getFiles() {
  try {
    const MyOctokit = Octokit.plugin(restEndpointMethods);
    const octokit = new MyOctokit({ auth: core.getInput("token", { required: true }) });
    const format = core.getInput("files_format", { required: true });

    if (format !== "text-list") {
      core.setFailed("file output format not supported.");
      return "";
    }

    const eventName = github.context.eventName;
    let base, head;

    switch (eventName) {
      case "pull_request":
        base = github.context.payload.pull_request.base.sha;
        head = github.context.payload.pull_request.head.sha;
        break;
      case "push":
        base = github.context.payload.before;
        head = github.context.payload.after;
        break;
      default:
        core.setFailed(
          `This action only supports pull requests and pushes, ${eventName} events are not supported.`
        );
        return "";
    }

    const response = await octokit.repos.compareCommits({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      base,
      head
    });

    if (response.status !== 200 || response.data.status !== "ahead") {
      core.setFailed("Base and head comparison failed or head is not ahead.");
      return "";
    }

    const files = response.data.files.map(f => f.filename);
    return files.join(' ');
  } catch (error) {
    core.setFailed(`Error fetching files: ${error.message}`);
    return "";
  }
}
