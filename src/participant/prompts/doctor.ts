import * as vscode from 'vscode';
import type { Document } from 'bson';

import { getStringifiedSampleDocuments } from '../sampleDocuments';
import type { PromptArgsBase, UserPromptResponse } from './promptBase';
import { PromptBase } from './promptBase';
import { codeBlockIdentifier } from '../constants';

interface DoctorPromptArgs extends PromptArgsBase {
  databaseName: string;
  collectionName: string;
  schema?: string;
  sampleDocuments?: Document[];
  connectionNames?: string[];
  schemaAdvice?: Object;
  suggestedIndexes?: Object;
  performanceAdvisorUrl?: string;
}

function getIndexExample({
  performanceAdvisorUrl,
}: {
  performanceAdvisorUrl?: string;
}): string {
  return `User: Why are my queries slow?
Response:
It looks like you are frequently querying customers by \`city\` but your collection does not have an index on the \`city\` attribute.
${codeBlockIdentifier.start}
db.getCollection.createIndex({ name: 1 });
${codeBlockIdentifier.end}
If an index exists on this attribute, MongoDB can use the index instead of sorting the entire dataset manually.${
    performanceAdvisorUrl
      ? `\nYou can see more details about this index suggestion on the [performance advisor page in Atlas](${performanceAdvisorUrl})`
      : ''
  }`;
}

function getSchemaExample({
  performanceAdvisorUrl,
}: {
  performanceAdvisorUrl?: string;
}): string {
  return `User: Queries to fetch transactions by customer id are slow. Help me make them faster.
Response:
I see that you have separate data models for customers and transactions. Nesting (or embedding) data is generally a good idea when dealing with one-to-few relationships, such as a blog post with a handful of comments.
${codeBlockIdentifier.start}
db.getCollection('customers').insertMany([
  {
    customer_name: 'Alice Johnson',
    address: '101 Elm Street',
    transactions: [
      {
        transaction_id: '1',
        item: 'abc',
        price: 10,
        quantity: 2,
        date: new Date('2014-03-01T08:00:00Z')
      },
      {
        transaction_id: '3',
        item: 'xyz',
        price: 5,
        quantity: 10,
        date: new Date('2014-03-15T09:00:00Z')
      },
      {
        transaction_id: '4',
        item: 'xyz',
        price: 5,
        quantity: 20,
        date: new Date('2014-04-04T11:21:39.736Z')
      }
    ]
  },
  {
    customer_name: 'Brian Lee',
    address: '202 Oak Avenue',
    transactions: [
      {
        transaction_id: '2',
        item: 'jkl',
        price: 20,
        quantity: 1,
        date: new Date('2014-03-01T09:00:00Z')
      },
      {
        transaction_id: '8',
        item: 'abc',
        price: 10,
        quantity: 5,
        date: new Date('2016-02-06T20:20:13Z')
      }
    ]
  },
  {
    customer_name: 'Carla Smith',
    address: '303 Pine Lane',
    transactions: [
      {
        transaction_id: '5',
        item: 'abc',
        price: 10,
        quantity: 10,
        date: new Date('2014-04-04T21:23:13.331Z')
      },
      {
        transaction_id: '6',
        item: 'def',
        price: 7.5,
        quantity: 5,
        date: new Date('2015-06-04T05:08:13Z')
      },
      {
        transaction_id: '7',
        item: 'def',
        price: 7.5,
        quantity: 10,
        date: new Date('2015-09-10T08:43:00Z')
      }
    ]
  }
]);
${codeBlockIdentifier.end}
All relevant customer and transaction data is together, making queries like "show all of Brian Lee's purchases" fast and efficient.${
    performanceAdvisorUrl
      ? `\nYou can see more details about schema suggestions based on observed usage on this cluster's [performance advisor page in Atlas](${performanceAdvisorUrl})`
      : ''
  }`;
}

export class DoctorPrompt extends PromptBase<DoctorPromptArgs> {
  protected getAssistantPrompt({
    schemaAdvice,
    suggestedIndexes,
    performanceAdvisorUrl,
  }: DoctorPromptArgs): string {
    const hasPerfomanceAdvisorData = !!schemaAdvice || !!suggestedIndexes;
    return `You are an expert MongoDB consultant who helps clients experiencing performance issues.
Your task is to help the user understand why their MongoDB queries are performing poorly, and to suggest one or more ways the user can improve the query's performance.
You might suggest improvements to the query itself or you might suggest something else, such as improvements to the schema of the underlying data models. Feel free to use your full knowledge about MongoDB best practices while helping the client.

${
  hasPerfomanceAdvisorData
    ? `You have access to the following data returned from MongoDB performance advisor APIs:
    ${
      schemaAdvice
        ? `

        API: /schemaAdvice
        : ${JSON.stringify(schemaAdvice)}
      `
        : ''
    }
    ${
      suggestedIndexes
        ? `

        API: /suggestedIndexes
        : ${JSON.stringify(suggestedIndexes)}
      `
        : ''
    }
Use this data if and only if it contains relevant information. When referring to this data, call it "performance data" but don't say it is from the API.
  `
    : ''
}

${
  performanceAdvisorUrl
    ? `
  You can also refer to the cluster's performance advisor page in Atlas for more details about suggestions: ${performanceAdvisorUrl}
`
    : ''
}

You must respond in this format:
  1. a concise explanation of the problem
  2. a reference to the code the user should rewrite in order to achieve the improvement
  3. a code snippet that attempts to rewrite that code in order to achieve the improvement. The code must be performant and correct. You must write it in a Markdown code block that begins with ${codeBlockIdentifier.start} and ends with ${codeBlockIdentifier.end}.
  4. a concise explanation of how the rewritten code addresses the problem
The only exception to this format is if for some reason you cannot provide helpful advice. In that case, explain to the user what they
can do to help you provide better advice.

You must also follow these rules:
Rule 1: If the user has specified which queries need attention, only provide advice about those queries.
Rule 2: If the user has not specified which queries need attention, provide advice about any query you can see.
Rule 3: Use some combination of ${hasPerfomanceAdvisorData ? 'the performance advisor data, ' : ''}your expert knowledge of MongoDB best practices, and the user's code to synthesize your answer. Briefly indicate which information you are using to arrive at your answer.
Rule 4: If you cannot find any way to improve the queries or data models that you are confident is good advice, do not imagine advice. Instead, tell the user that you can't find anything wrong with their models or queries.
Rule 5: Be concise. Your answer must be a few paragraphs or less.
Rule 6: Do not provide general advice. Only provide targeted insights that address real problems with the user's queries or data models.
Rule 7: If the performance data doesn't seem to correspond to the user's code, point out the problem instead of trying to offer advice.${
      performanceAdvisorUrl
        ? "\nRule 8: If the performance advisor data is relevant, you must include a link to the cluster's performance advisor page in Atlas. This page contains more details about the suggestions and is a good place for the user to go for more information, but only contains information about the suggestions themselves, and not any monitoring to be tracked after applying them."
        : ''
    }

___
Example 1:
${getIndexExample({ performanceAdvisorUrl })}

Example 2:
${getSchemaExample({ performanceAdvisorUrl })}

Example 3:
User: Why are my queries slow?
Response: Based on your performance data, it doesn't actually look like their are any issues with your queries! Also, your code seems to be
following MongoDB best practices. What is making you think there is a problem with your queries?
`;
  }

  async getUserPrompt({
    databaseName = 'mongodbVSCodeCopilotDB',
    collectionName = 'test',
    request,
    schema,
    sampleDocuments,
  }: DoctorPromptArgs): Promise<UserPromptResponse> {
    let prompt = request.prompt;
    prompt += `\nDatabase name: ${databaseName}\n`;
    prompt += `Collection name: ${collectionName}\n`;
    if (schema) {
      prompt += `Collection schema: ${schema}\n`;
    }

    const sampleDocumentsPrompt = await getStringifiedSampleDocuments({
      sampleDocuments,
      prompt,
    });

    return {
      prompt: `${prompt}${sampleDocumentsPrompt}`,
      hasSampleDocs: !!sampleDocumentsPrompt,
    };
  }

  get emptyRequestResponse(): string {
    return vscode.l10n.t(
      'Please specify a question when using this command. Usage: @MongoDB /doctor help me understand why my queries for plant species by leaf shape are slow.',
    );
  }
}
