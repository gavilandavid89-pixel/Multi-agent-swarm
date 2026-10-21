import test from 'node:test';
import assert from 'node:assert/strict';
import { consultarWithProviderContext } from '../apps/worker/services/aiProviders.js';

test('recovers provider JSON tool-call validation error with a tool-free retry', async () => {
 const originalFetch = globalThis.fetch; const bodies=[]; let calls=0;
 globalThis.fetch=async (_url, options)=>{ calls++; bodies.push(JSON.parse(options.body)); if(calls===1) return new Response(JSON.stringify({error:{message:"Tool call validation failed: attempted to call tool 'JSON' which was not in request.tools",code:'tool_use_failed'}}),{status:400}); return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'{\"verdict\":\"APPROVED\",\"findings\":[],\"summary\":\"OK\"}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:8,total_tokens:18}}),{status:200}); };
 try { const result=await consultarWithProviderContext({model:'test-model',maxTokens:1200,messages:[{role:'user',content:'Respondé con JSON.'}],tools:[{type:'function',function:{name:'agent_tasks_list',description:'List tasks',parameters:{type:'object',properties:{}}}}],onToolCall:async()=>{throw new Error('Unexpected tool call');}},{providers:[{name:'Groq',baseUrl:'https://api.groq.com/openai/v1',apiKey:'dummy',model:'test-model',models:{reasoning:'test-model'}}],geminiProviders:[]},{NODE_ENV:'test'}); assert.equal(calls,2); assert.equal(bodies[1].tool_choice,'none'); assert.match(bodies[1].messages.at(-1).content,/JSON es el formato de salida/); assert.match(result,/APPROVED/); } finally { globalThis.fetch=originalFetch; }
});
