# Browser model evaluation

## 20 October 2026: GPT-5.6 Luna and GPT-5.6 Terra

One exploratory trial compared the two models at **medium reasoning**. Each received the same read-only job-screening task, the same candidate facts and screening criteria, and the same three live Liepin postings. Each used its own assigned Chrome tab through the custom extension and local bridge. Both returned `transport: extension`. A separate review checked the live pages and screenshots.

The task required extracting job facts, distinguishing recruiting agencies from hiring companies, comparing requirements with the supplied profile, ranking the roles, and drafting one short outreach message. Nothing was sent or submitted.

### Manual scores

| Dimension | Maximum | GPT-5.6 Luna | GPT-5.6 Terra |
| --- | ---: | ---: | ---: |
| Extraction and complete requirements | 40 | 36 | 36 |
| Screening and ranking judgment | 30 | 23 | 27 |
| Browser execution and screenshot evidence | 20 | 20 | 20 |
| Scope and instruction adherence | 10 | 10 | 10 |
| **Total** | **100** | **89** | **93** |

### Observations

- Both completed the three-page browser task, extracted the main fields accurately, distinguished agency recruiters from undisclosed employers, and avoided inventing remote arrangements.
- Both noticed a role's explicit exception for high-potential junior candidates despite a longer experience requirement elsewhere in the description.
- Both missed a contradiction in another advert: its header requested a master's degree and 3–5 years, while its detailed requirements allowed a bachelor's degree and one year of Agent experience. The task's salary-floor filter still excluded that role, but the degree and experience explanation was too definite. This accounts for the extraction deduction.
- Terra explicitly noted the uncertainty around a production-heavy role's high-throughput experience requirements. Luna relied more heavily on the permissive header requirements and did not make those gaps clear. Neither result established a fully verified fit; this accounts for the judgment deductions.
- Both kept the task read-only and produced drafts without claiming unverified qualifications. No messages, applications, uploads, or profile changes were made.
- The draft-length instruction said “120 Chinese characters,” which was ambiguous with Latin technology names. Terra produced136 total Unicode characters /31 Han; Luna188 /50. No deduction was made for that ambiguity. Future trials should specify a limit in total Unicode code points.

### Tentative workflow

Use **Luna** for initial structured extraction and simple filters. Use **Terra** for a second screening pass where requirement interpretation matters. Have a stronger model review contradictory requirements, uncertain matches, and personalized application messages before consequential actions.

These recommendations are provisional. The four-point difference comes from a manual assessment of one three-posting trial; it is not evidence of a general capability ranking or a reliable failure rate. Shared browser conditions and self-reported timing do not support a speed comparison. Token usage and cost were not measured. The test did not evaluate sending messages, completing application forms, recovery from browser failures, or longer autonomous work.

### Next evaluation

Repeat on a larger, varied set of postings with frozen page evidence. Include conflicting requirements, explicit junior exceptions, remote restrictions, language requirements, undisclosed employers, and unverified technology requirements. Specify field-level expected answers and exact output-length rules in advance. Record per-run time and usage independently, and repeat each task before drawing stronger conclusions.

Personal candidate details, recruiter names, conversation text, account screenshots, and local machine paths are intentionally excluded from this repository note. Detailed private evidence remains outside the repository.
