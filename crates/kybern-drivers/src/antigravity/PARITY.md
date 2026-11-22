# Antigravity: what the `-p` driver and the daemon provide today

Written before the `agy acp` path was added, as the bar it must meet: every row
keeps working on the `-p` path (which stays as the fallback), and every row
that applies to a long-lived session must also hold on ACP. Each row names the
test that covers it today (`drivers` = `crates/kybern-drivers/src`, `daemon` =
`crates/kybern-daemon/src`). "Both" means the behaviour belongs to a running
session and must be checked against both paths; "shared" means it lives
outside the session (daemon, login, quota, skills, import) and both paths reach
the same code.

## Turns and output

| # | Behaviour | Applies to | Covered today by |
|---|-----------|------------|------------------|
| 1 | A text turn streams `TextDelta`s, binds the session (`SessionBound` with the conversation id and model) and ends `TurnCompleted { Completed }` | Both | drivers `antigravity/tests.rs::a_text_turn_streams_binds_and_completes_with_step_usage`; live `tests/live_drivers.rs::antigravity_streams_runs_a_tool_resumes_and_lists_models` |
| 2 | **Usage:** per-turn tokens only (never the cumulative conversation total); `output_tokens` already includes thinking tokens, so thinking is not counted twice; cache reads are reported separately | Both | `tool_steps_become_cards_and_cumulative_result_usage_is_ignored`, `a_text_turn_streams_binds_and_completes_with_step_usage` |
| 3 | The final answer text is authoritative: a streamed message missing its tail is corrected, a turn that streamed nothing still shows its answer | `-p` (ACP streams whole chunks and has no separate final text) | `the_result_text_is_authoritative` |
| 4 | Stop mid-turn ends the turn as `Interrupted`; a process that ignores the polite stop is escalated and its tool children die | Both | `process::interrupt_sends_sigint_and_ends_the_turn_as_interrupted`, `process::a_process_that_ignores_sigint_is_escalated_to_a_stop`; live `antigravity_interrupt_ends_the_turn_and_kills_the_tool_child` |
| 5 | Resume: turns after the first continue the same conversation (`--conversation <id>`); a thread's stored id resumes after a daemon restart | Both | `process::turns_run_one_process_each_and_resume_the_conversation`; live `antigravity_streams_runs_a_tool_resumes_and_lists_models` |
| 6 | A second message while a turn runs is refused (`-p`); ACP may steer instead (agy ≥ 1.5.0) | `-p` refuses, ACP steers | `process::a_second_message_during_a_turn_is_refused` |
| 7 | Model and effort: tiered slugs (`gemini-3.8-flash-high/-medium/-low`) group into one model row with efforts; the effort picks the slug at turn start; live model and effort switches apply to the next turn | Both (catalog shared) | `models_come_from_the_tab_separated_list`, `tiers_of_one_model_become_one_row_with_efforts`, `the_effort_picks_the_tier_slug`, `one_turn_is_built_exactly_as_the_spec_says` |
| 8 | The native slash commands (`goal`, `plan`, `grill-me`, `learn`) are advertised | Both | `command_tests::print_mode_advertises_only_supported_commands` |

## Recovery

| # | Behaviour | Applies to | Covered today by |
|---|-----------|------------|------------------|
| 9 | **Thinking-signature recovery:** Claude's invalid/missing thinking-signature error is detected (in the error and in `problem.detail`), drops the conversation id, and retries once through the shared resend guard (`resend.rs`, `ResendReason::AntigravitySignature`) on a fresh conversation seeded with the thread's earlier turns | Both | drivers `invalid_thinking_signature_is_detected_and_poisons_the_mapper`, `process::a_poisoned_thinking_signature_drops_the_conversation_id_for_the_next_turn`; daemon `antigravity_thinking_signature_failure_retries_once_on_a_fresh_conversation_with_context` |
| 10 | A declined recovery (second failure on the turn, released or retiring session, missing prompt) still resets the conversation and writes the handoff, so the next message keeps the context | Shared (daemon) | daemon `antigravity_declined_recovery_when_session_is_released_preserves_handoff` |
| 11 | Stop during the recovery retry cancels the resend | Shared (daemon) | daemon `stop_during_antigravity_thinking_signature_retry_cancels_resend` |
| 12 | **"Edit from here"** / revert: starts a fresh conversation seeded with the kept turns (portable handoff), including at the first checkpoint with imported history | Both | daemon `antigravity_revert_rewinds_by_starting_a_fresh_conversation_seeded_with_kept_transcript`, `edit_from_here_at_first_checkpoint_preserves_imported_history`, `edit_from_here_after_failed_harness_switch_preserves_handoff_for_non_antigravity`, `antigravity_rules::tests::events_without_reverted_applies_reverts_emitted_after_through` |
| 13 | The driver refuses native fork and rewind (the daemon uses the handoff instead) | Both | `spawn_refuses_what_agy_cannot_do` |

## Errors people can act on

| # | Behaviour | Applies to | Covered today by |
|---|-----------|------------|------------------|
| 14 | **Narrowed sign-in classifier:** only real sign-in failures say "sign in"; a runtime crash that mentions auth words does not | Both | drivers `failure.rs::antigravity_sign_in_classifier_ignores_crashes_mentioning_auth_words`, `antigravity/tests.rs::friendly_error_does_not_blame_sign_in_for_runtime_crashes`, `failures_say_what_to_do_next`, `failure.rs::cursor_grok_opencode_pi_and_antigravity_signed_out_texts` |
| 15 | **404:** before the model answered it is an unknown or unentitled model (`NotFound`, action `choose_model` with `{provider: antigravity}`, not retryable); after the model answered it is a temporary error with Try again | Both | `a_failed_turn_with_an_error_step_still_fails` |
| 16 | **Quota reset hint:** the reset time in agy's quota error becomes the problem's hint | Both | `failure.rs::antigravity_quota_reset_time_is_parsed_into_the_problem_hint` |
| 17 | **Repeated stale errors:** agy 1.5.12 repeats an earlier turn's error after a complete answer; that turn does not fail | `-p` (ACP has no repeated `result.error`) | `an_earlier_turns_error_repeated_after_an_answer_does_not_fail_the_turn` |
| 18 | A failed first turn keeps the guide for the retry; a turn that never opened a conversation re-offers it | Both | `process::a_failed_first_turn_keeps_the_guide_for_the_retry` |
| 19 | A crash with no result says what agy printed; an exit with no answer says to send again | Both | `failures_say_what_to_do_next` |

## Tools

| # | Behaviour | Applies to | Covered today by |
|---|-----------|------------|------------------|
| 20 | agy tool names map to Kybern's (`run_command` → `Bash`, `view_file` → `Read`, …) with the original parameters under `input.raw` | Both | `tool_names_and_inputs_are_normalised_with_the_original_kept` |
| 21 | **`call_mcp_tool` shown as `mcp__server__tool`** with the MCP tool's own arguments | Both | `a_kybern_tool_call_is_named_like_the_other_harnesses_name_it` |
| 22 | **MCP schema-cache reads hidden** (agy reading `~/.gemini/antigravity-cli/mcp/<server>/<tool>.json`) | Both | `agy_reading_its_own_mcp_schema_shows_nothing` |
| 23 | **Thin tool parameters filled from the transcript** (`brain/<id>/.system_generated/logs/transcript.jsonl`) without ever failing a turn | Both (ACP's `rawInput` is complete; the fallback stays) | `a_thin_call_borrows_arguments_from_the_transcript_without_failing` |
| 24 | A tool that ends in error, or a shell result with a nonzero exit, is an error card; a tool that only reports done still gets its start | Both | `a_tool_step_that_ends_in_error_still_completes_with_the_error_text`, `a_tool_that_only_reports_done_still_gets_its_start`, `tool_steps_become_cards_and_cumulative_result_usage_is_ignored` |

## Kybern's tools, guide, skills

| # | Behaviour | Applies to | Covered today by |
|---|-----------|------------|------------------|
| 25 | **Kybern tools:** the one global `kybern mcp-bridge` entry; the session's endpoint and credential travel only in the agy process environment, never on its command line | Both | drivers `process::the_bridge_endpoint_travels_in_the_environment_not_on_the_command_line`; daemon `antigravity_mcp.rs::only_a_kybern_bridge_entry_is_ours`, `a_missing_file_has_no_entry`, `antigravity_sessions_get_a_tool_free_guide_and_no_gateway_session` |
| 26 | **The guide is sent once:** on a new conversation's first ordinary prompt (a slash command leaves it for the next one); a resumed conversation gets it only when it lacks it | Both (ACP may carry it in the system prompt instead) | `process::a_resumed_session_sends_the_guide_only_when_the_conversation_lacks_it`, `process::a_failed_first_turn_keeps_the_guide_for_the_retry`; daemon `every_new_session_receives_the_guide_for_its_own_tools_unless_turned_off` |
| 27 | **Skills:** discovery of agy's own roots and `skills.json` manifests (inherits, literal filters, nulls, files); home agents' skills skipped | Shared (daemon) | daemon `skills.rs::antigravity_reads_its_native_roots_and_skips_home_agents_skills`, `antigravity_reads_skills_json_manifests_with_inherits_literal_filters_nulls_and_files` |
| 28 | Antigravity cannot lead a project (Kybern can't enforce read-only tools) | Shared (daemon + driver) | daemon `antigravity_cannot_lead_a_project`; drivers `spawn_refuses_what_agy_cannot_do` |

## Permission modes

| # | Behaviour | Applies to | Covered today by |
|---|-----------|------------|------------------|
| 29 | Full access only on `-p` (`--dangerously-skip-permissions`); every other mode is refused wherever it is set, with the one sentence | `-p` | drivers `only_full_access_is_accepted_everywhere`; daemon `antigravity_threads_are_created_and_changed_only_in_full_access`, `switching_a_thread_to_antigravity_never_grants_it_full_access`, `delegation_to_antigravity_needs_a_full_access_parent_and_never_narrows`, `antigravity_rules::tests::only_antigravity_is_held_to_full_access` |
| 30 | One Antigravity account per machine | Shared | daemon `antigravity_has_one_account_per_machine` |

## Titles, login, quota

| # | Behaviour | Applies to | Covered today by |
|---|-----------|------------|------------------|
| 31 | **Title one-shots** run on `-p` in a scratch folder with `--mode plan` and clean up their conversation (only rows for their own scratch workspace). They stay on `-p` | `-p` only | `process::one_shot_answers_from_the_result_in_plan_mode`, `process::one_shot_cleans_up_its_temporary_conversation_and_leaves_others_alone`, `process::one_shot_cleans_up_summary_row_with_no_workspace`, `one_shot_cleanup_only_deletes_summary_rows_for_its_scratch_workspace`; live `antigravity_one_shot_answers_a_title_prompt_without_editing` |
| 32 | **Quota host:** the right metered host for Workspace vs personal accounts; limits are read without opening a browser and a sign-in ask is not repeated for the same login | Shared | `business_and_consumer_accounts_are_distinguished_for_quota_host_order`, `workspace_and_personal_accounts_read_their_own_metered_quota_host`, `a_usage_that_asks_to_sign_in_opens_no_browser_and_is_not_repeated_for_the_same_login`, `an_expired_token_reads_the_limits_from_agy_instead_of_going_stale`, `a_token_kybern_cannot_find_reads_the_limits_from_agy_too`, `accounts_keep_their_own_agy_answers_and_pauses`, `a_signed_out_agy_is_asked_once_and_remembered_until_a_login_appears`, `an_expired_login_is_renewed_by_agy_models_and_read_without_usage`, quota parsing tests (`quota_buckets_merge_by_id_and_map_the_windows`, `an_unstarted_window_has_no_reset_time`, `the_project_and_plan_come_from_load_code_assist`, `every_group_becomes_rows_gemini_first`, `agy_usage_json_parses_into_the_same_rows`, …) |
| 33 | The stored login yields an email and an expiry and never shows the token | Shared | `the_stored_login_yields_an_email_and_an_expiry_and_hides_the_token`, `a_keyring_value_is_read_in_each_of_go_keyrings_wrappers` |
| 34 | Probe: version check (≥ 1.4.11), model list cached and kept when signed out, install hint | Shared | `process::probe_lists_models_and_checks_the_version`, `a_signed_out_agy_models_is_told_from_its_output` |

## Platform

| # | Behaviour | Applies to | Covered today by |
|---|-----------|------------|------------------|
| 35 | **Windows:** `.cmd` launchers (npm/pnpm shims) run their target; agy is found where its installer puts it | Both | `binary.rs::npm_shim_runs_its_script_with_node`, `npm_shim_runs_a_native_target_directly`, `pnpm_shim_runs_its_script_with_node`, `unknown_or_dangling_shims_are_left_alone`, `antigravity/tests.rs::agy_is_found_where_its_installer_puts_it` |
| 36 | **`~` expansion** of the configured binary; the home folder comes from the platform's variable, skipping empty ones | Both | `binary.rs::resolve_expands_leading_tilde_against_home`, `home_from_env_prefers_platform_variable_and_skips_empty`, `antigravity/tests.rs::env_home_prefers_platform_home_variable_and_skips_empty` |

## Session import and images

| # | Behaviour | Applies to | Covered today by |
|---|-----------|------------|------------------|
| 37 | **Session import** from `conversation_summaries.db` and `transcript.jsonl` (turns, tool cards, notices, truncated content, subagents skipped, read-only) | Shared (ACP conversations land in the same store) | `sessions/antigravity_tests.rs::a_transcript_becomes_turns_tool_cards_and_notices`, `truncated_content_is_read_from_the_full_transcript`, `the_list_skips_subagents_and_finds_each_conversations_folder`, `reading_never_touches_the_antigravity_folder`, `no_store_is_an_empty_list_and_an_unfinished_last_line_means_in_use`, `file_uris_become_paths`; daemon `session_import/tests.rs::antigravity_conversations_group_by_repository_and_import_with_their_cards` |
| 38 | **Images:** image attachments reach the agent (`-p`: saved in the session's scratch folder and named by path; ACP: image blocks, which `agy acp` advertises) | Both | `a_prompt_flattens_parts_and_saves_images_in_the_scratch_folder` |
| 39 | The session's scratch folder (log file, images) is removed with the session | `-p` | `Scratch`'s `Drop` (no direct test) |
