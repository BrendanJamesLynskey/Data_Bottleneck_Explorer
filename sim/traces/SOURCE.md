# Azure LLM inference traces (2023)

The two CSV files here are copied unchanged from Microsoft's
[AzurePublicDataset](https://github.com/Azure/AzurePublicDataset), commit `215becdacba1ce682c7368642ce97d5a332de7a6`
(fetched 2026-10-27), `data/AzureLLMInferenceTrace_code.csv` and `data/AzureLLMInferenceTrace_conv.csv`. They are
described in [AzureLLMInferenceDataset2023.md](https://github.com/Azure/AzurePublicDataset/blob/master/AzureLLMInferenceDataset2023.md).

**Licence:** [Creative Commons Attribution 4.0](https://github.com/Azure/AzurePublicDataset/blob/master/LICENSE).
**Attribution**, as the dataset asks:

> Pratyush Patel, Esha Choukse, Chaojie Zhang, Aashaka Shah, Íñigo Goiri, Saeed Maleki, Ricardo Bianchini.
> "Splitwise: Efficient generative LLM inference using phase splitting", in Proceedings of the International
> Symposium on Computer Architecture (ISCA 2024). ACM, 2024.

## What is in them

One row per request to one of two LLM inference services in Azure:
- `TIMESTAMP`: when the request arrived;
- `ContextTokens`: prompt length in tokens;
- `GeneratedTokens`: reply length in tokens.

The prompt text isn't included; the README cites customer privacy (GDPR).

| File | Service | Requests | Span | SHA-256 |
|---|---|---|---|---|
| `AzureLLMInferenceTrace_code.csv` | code completion | 8,819 | 57 min | `54e9a6d2…7fb6` |
| `AzureLLMInferenceTrace_conv.csv` | conversation | 19,366 | 58 min | `2f1e5b66…0bf8` |

The timestamps read 16 November 2023, although the dataset description says the traces were collected on
11 November.

`sim/azure_trace.py` refuses a file whose SHA-256 differs from the one above. `sim/test_azure_trace.py` checks that the median
prompt and reply lengths match those the Splitwise paper reports (Section III):
- prompts: 1,500 tokens for code and 1,020 for conversation;
- replies: 13 and 129 tokens.

The code file gives 1,469 (2 % below the paper's rounded 1,500); the other three medians match exactly.
