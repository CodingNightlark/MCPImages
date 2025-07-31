#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from 'fs';
import fetch from 'node-fetch';

const server = new McpServer({
  name: "mcp-images",  
  version: "1.0.0"
});
  
const imageSchema = z.object({
  url: z.string().url(),  
  alt: z.string().optional(),  
  width: z.number().optional(),   
  height: z.number().optional() 
 
});      
      
const inputSchema = z.object({
  words: z.string().describe("list of comma-separated words that will each generate an image"),
  provider: z.string().describe("name of the image provider to use")
}); 
 
async function generateImages(input) {
  const { words, provider } = inputSchema.parse(input); 
  const wordList = words.split(",").map(word => word.trim().filter(word => word.length > 0));
  const results = [];
  if (wordList.length === 0) {
    throw new Error("No valid words provided for image generation.");
  }
  if (!fs.existsSync('generated-images')) {
  fs.mkdirSync('generated-images');
  }

  for (let i = 0; i < wordList.length; i++) { 
  var prompt = 'white background, ghibli style ' + wordList[i];
  const requestBody = {
      model: "dall-e-3", 
      prompt: prompt,
      size: "1024x1024",  
      quality: "standard",
      n: 1
  };  
try{
  const response = await fetch(`https://api.openai.com/v1/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer YOUR_API_KEY_HERE`
    },
    body: JSON.stringify(requestBody)
  });

// Skip to the next word if there's an error
 
  const data = await response.json();  
  const imageUrl = data.data[0].url;
  const imageResponse = await fetch(imageUrl);

  const fileName = `generated-images/${wordList[i]}.png`;
  const fileStream = fs.createWriteStream(fileName);
  imageResponse.body.pipe(fileStream);
  await new Promise((resolve, reject) => { 
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  results.push({
    url: `file://${process.cwd()}/${fileName}`,
    alt: `Image of ${wordList[i]}`,
    width: 1024,
    height: 1024
  });

} 
catch (error) {
    console.error(`Error generating image for "${wordList[i]}":`, error);
    results.push({
      url: null,
      alt: `Failed to generate image for ${wordList[i]}`,
      width: null,
      height: null
    });
  }
  }

  return results;
}
 
server.registerTool ({  
  name: "generateImages",
  description: "Generates images based on a list of words using a specified provider.",
  inputSchema: inputSchema,
  outputSchema: z.array(imageSchema),
  execute: async (input) => {
    return generateImages(input);
  }  
})

const transport = new StdioServerTransport();
await server.connect(transport);

   