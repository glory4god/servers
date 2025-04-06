#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Schema definitions
const FetchApiArgsSchema = z.object({
  url: z.string().url().describe('The URL to fetch data from'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'DELETE'])
    .default('GET')
    .describe('HTTP method to use'),
  headers: z
    .record(z.string())
    .optional()
    .describe('HTTP headers to include in the request'),
  body: z.string().optional().describe('Request body (for POST/PUT requests)'),
  extractMassData: z
    .boolean()
    .optional()
    .default(false)
    .describe('Extract mass data from HTML response'),
});

const ProcessDataArgsSchema = z.object({
  data: z.string().describe('Raw JSON data string to process'),
  format: z
    .enum(['compact', 'detailed'])
    .default('detailed')
    .describe('Output format preference'),
  filterFields: z
    .array(z.string())
    .optional()
    .describe('Fields to include in the output'),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Server setup
const server = new Server(
  {
    name: 'new-server-1',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Utility function to make API requests
async function makeApiRequest(
  url: string,
  method: string,
  headers?: Record<string, string>,
  body?: string,
) {
  try {
    // Add API key to headers if provided
    const requestHeaders = {
      ...(headers || {}),
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body ? body : undefined,
    });

    if (!response.ok) {
      throw new Error(`API request failed with status: ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    } else {
      return await response.text();
    }
  } catch (error) {
    throw new Error(
      `Failed to fetch API data: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// Data processing function
function processApiData(rawData: any, format: string, filterFields?: string[]) {
  // HTML에서 script 태그 내 __NEXT_DATA__ 데이터를 추출하는 함수
  if (typeof rawData === 'string' && rawData.includes('__NEXT_DATA__')) {
    try {
      // script id="__NEXT_DATA__" 태그 내용 추출
      const scriptMatch = rawData.match(
        /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
      );

      if (scriptMatch && scriptMatch[1]) {
        // JSON 파싱
        const jsonData = JSON.parse(scriptMatch[1]);

        // mass 데이터 추출 (페이지 프롭스 내에 있음)
        if (jsonData.props?.pageProps?.mass) {
          let massData = jsonData.props.pageProps.mass;

          // 필터링 로직 (특정 필드만 반환)
          if (filterFields && filterFields.length > 0) {
            const filteredData: Record<string, any> = {};

            filterFields.forEach((field) => {
              if (field in massData) {
                filteredData[field] = massData[field];
              }
            });

            massData = filteredData;
          }

          // 출력 포맷 지정
          if (format === 'compact') {
            // 간결한 형태로 최소한의 정보만 제공
            const compactResult = {
              title: massData.title,
              subTitle: massData.subTitle,
              regionName: massData.regionName,
              regionPriceRankContent: massData.regionPriceRankContent
                ? massData.regionPriceRankContent.slice(0, 15)
                : [],
            };

            return compactResult;
          }

          // 기본 형태 (detailed)는 전체 데이터 반환
          return massData;
        }

        return { error: 'mass data not found in the provided HTML' };
      }

      return { error: '__NEXT_DATA__ script content not found' };
    } catch (error) {
      return {
        error: 'Failed to parse script data',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // HTML이 아닌 경우 원본 데이터 반환
  return {
    processed: true,
    data: rawData,
    format,
    filterFields,
  };
}

// Server handlers setup
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'fetch_api',
        description:
          'Fetch data from a specified API endpoint. ' +
          'Makes an HTTP request to the provided URL and returns the response. ' +
          'Supports various HTTP methods and custom headers. ' +
          'API key is automatically included in the Authorization header.',
        inputSchema: zodToJsonSchema(FetchApiArgsSchema) as ToolInput,
      },
      {
        name: 'process_data',
        description:
          'Process API response data into a structured format. ' +
          'Takes raw API data (usually JSON) and processes it according to specified format. ' +
          'Can filter data to include only specific fields. ' +
          'Returns processed data ready for client consumption.',
        inputSchema: zodToJsonSchema(ProcessDataArgsSchema) as ToolInput,
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'fetch_api': {
        const parsed = FetchApiArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for fetch_api: ${parsed.error}`);
        }

        const result = await makeApiRequest(
          parsed.data.url,
          parsed.data.method,
          parsed.data.headers,
          parsed.data.body,
        );

        // 자동으로 mass 데이터 추출이 요청된 경우
        if (parsed.data.extractMassData && typeof result === 'string') {
          const processedData = processApiData(result, 'detailed');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(processedData, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text:
                typeof result === 'string'
                  ? result
                  : JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'process_data': {
        const parsed = ProcessDataArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(
            `Invalid arguments for process_data: ${parsed.error}`,
          );
        }

        let data;
        try {
          data = JSON.parse(parsed.data.data);
        } catch (e) {
          // If not JSON, use as is
          data = parsed.data.data;
        }

        const processed = processApiData(
          data,
          parsed.data.format,
          parsed.data.filterFields,
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(processed, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('API MCP Server running on stdio');
  console.error('Server is ready to process API requests');
}

runServer().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
