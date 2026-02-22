import { llm, voice } from '@livekit/agents';
import { z } from 'zod';

const INSTRUCTIONS = `\
You are a friendly, helpful voice assistant called Botical. \
You speak in a natural, conversational tone. \
Keep your responses concise — aim for 1-3 sentences unless the user asks for more detail. \
Never use markdown formatting, bullet points, or numbered lists since the user is listening, not reading. \
If you don't know something, say so honestly. \
When you need to use a tool, just call it immediately without saying anything first. \
Do not announce or narrate tool calls — the user will see the result. \
Stay consise.
In appropriate contexts, you can laugh by printing the exact characters: [laughter]
`;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

const tools: llm.ToolContext = {
  get_time: llm.tool({
    description: 'Get the current date and time.',
    execute: async () => {
      const now = new Date();
      return `It is ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })} on ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`;
    },
  }),
  set_reminder: llm.tool({
    description: 'Set a reminder for the user. Confirm the reminder back to the user.',
    parameters: z.object({
      message: z.string().describe('What to remind the user about'),
      minutes: z.number().describe('How many minutes from now'),
    }),
    execute: async ({ message, minutes }) => {
      console.log(`[${ts()}] [tool:set_reminder] "${message}" in ${minutes} minutes`);
      return `Reminder set: "${message}" in ${minutes} minutes.`;
    },
  }),
};

export class BotAgent extends voice.Agent {
  constructor() {
    super({ instructions: INSTRUCTIONS, tools });
  }

  override async onEnter(): Promise<void> {
    console.log(`[${ts()}] [agent] onEnter — waiting for user`);
  }

  override async onExit(): Promise<void> {
    console.log(`[${ts()}] [agent] onExit — agent deactivated`);
  }
}
