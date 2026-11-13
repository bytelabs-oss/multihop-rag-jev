# Atlas visual system

A document analysis workstation. Three panels keep source documents, projected passages, and source evidence visible together. The map is the primary working area. Use deep olive backgrounds, pale green actions, and a distinct muted color per source. DM Sans handles controls and passages; Manrope handles headings. Selected nodes reveal connections and exact cosine similarity while a persistent notice explains projection limits.

Keep the document list bounded so retrieved chunks remain visible for large corpora. Retrieved is the default evidence view for a new run; Kept and Dropped are separate post-retrieval groups with counts.

Compare the shared GPT answer step separately from whole-run totals. Do not draw JEV cost or token series for non-JEV modes. Mark answers that were not generated as Not called rather than presenting them as free completed answers.

Question selection opens a focused browser from one button beside the composer. Show full question text as selectable rows, not dropdown options. Only offer answerable questions whose source articles are all loaded, and state how many are available. Keep search, example-set controls, and pagination outside the scrolling results. Search covers all available questions for the loaded corpus. Selecting a row fills the composer and focuses it when enabled; cancelling preserves the draft and returns focus to the browse button. Neither action runs a question.

The benchmark has a separate page so long-running evaluation does not replace the workspace. Keep setup and cost confirmation explicit, show overall progress and completion denominators, and make saved question rows open their mode results. Reuse the existing evidence, answer, usage, and chart views. Reference answers belong only in the scoring inspector, not generation inputs. Partial results and the permissive repository score must be labeled.

Desktop uses a 252px document panel and 325px inspector. Below 950px the inspector is an overlay, below 640px documents become a drawer and the inspector a bottom panel. Support a list view, keyboard-selectable map nodes, and reduced motion. Do not add a fake chat or simulated answers.
