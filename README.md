# MCP Image Generator

This is a tool server for generating images from a list of words, making it more efficient to generate a list of images of objects in the same style (needed for a personal project lol) . It supports asynchronous background generation to avoid timeouts and offers tools for checking status, listing, and deleting generated images.
note that you will have to check status to see errors as well

## Features

-  Generate images from a comma-separated list of words
-  Support for DALL·E 3 and Stability AI 
        Note that I haven't been able to test DALLE-3 as the credits are costly (I will use the grant towards their API btw and update this then) 
- All images will come back in the same style
-  Asynchronous background job processing
-  List and delete generated images

For using it: type 'stability' under providers (only one I have properly tested and works)
You can choose style but results are best with either 'realistic' or 'cartoon' for best results


## 🛠️ Requirements

- Node.js 18+
- stability API key
- setup config file

Example config file: {
  "mcpServers": {
    "images": {
      "command": "npx",
      "args": ["mcp-images"],
      "env": {
        "OPENAI_API_KEY": "your_openai_api_key_here",
        "STABILITY_API_KEY": "your_stability_api_key_here"
      }
    }
  }
}


