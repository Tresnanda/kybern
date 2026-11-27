# Antigravity: what the `-p` driver and the daemon provide today

Written before the `agy acp` path (`acp.rs`) was added, as the bar it must meet: every row
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
| 30 | Named accounts: each has its own profile (`agy acp --gemini-dir <account>/.gemini`, the login a file there, out of the keyring) and signs in with `agy acp --login` and a pasted code; sessions need ACP, and `-p` one-shots, `/usage` and `agy models` run with the account folder as `HOME` | ACP (sessions), shared (sign-in, limits, titles) | drivers `account::tests`, `a_named_account_runs_on_its_own_profile_and_never_on_print`; daemon `a_named_antigravity_account_runs_on_its_own_profile_out_of_the_keyring`, `a_second_antigravity_account_signs_in_to_its_own_profile_with_a_pasted_code` |

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

## Status on both paths

Checked after the ACP path landed. "Pass" names the test that shows it; `acp_tests` is
`antigravity/acp_tests.rs` (a scripted `agy acp`), "live" is `tests/live_drivers.rs` against
the real `agy` 1.5.14 (`gemini-3.8-flash`, low effort), each scenario run on both transports,
and "daemon" is a scratch `kybernd` driven with the CLI.

| # | `-p` | ACP |
|---|------|-----|
| 1 | Pass (unchanged tests; live) | Pass: `agy_1_5_runs_on_acp_and_takes_every_mode`; live |
| 2 | Pass (unchanged) | Pass: `agys_tool_names_and_prompt_usage_survive_acps_types` (recorded agy 1.5.14 usage: `inputTokens` without cache reads, `outputTokens` with thinking), `supervised_asks_and_shows_the_call_as_print_names_it`; live usage within a few tokens of `-p` for the same turn |
| 3 | Pass (unchanged) | Not applicable: ACP streams the whole text and has no separate final answer |
| 4 | Pass (unchanged; live) | Pass: `stop_cancels_the_prompt_and_its_command`; live (child killed); daemon (0.15 s) |
| 5 | Pass (unchanged; live resume in a new session) | Pass: `the_guide_goes_in_the_system_prompt_once_…` (`session/load`, replay hidden), `a_crash_mid_turn_fails_it_plainly_and_ends_the_session_for_a_respawn`; live; daemon release + resume. `agy acp` resumes `-p` conversations and back: live `antigravity_conversations_resume_from_print_on_acp_and_back` |
| 6 | Pass (unchanged: refused) | Steers: `a_steer_carries_the_turn_on_and_both_prompts_count` |
| 7 | Pass (unchanged) | Pass: `a_tier_slug_runs_as_its_family_at_the_tier_the_effort_picks`, `the_model_and_effort_go_through_config_options_and_switches_wait_for_the_next_prompt` |
| 8 | Pass (unchanged) | agy sends its own, longer list (`available_commands_update`) |
| 9 | Pass (unchanged daemon tests) | Pass: `agys_recorded_errors_fail_the_turn_as_print_words_them` (the error step's text reaches the same classifier, so the daemon's guard sees it); the retry is a fresh `session/new` seeded by the daemon's handoff, as on `-p` |
| 10–11 | Pass (daemon, unchanged) | Same daemon code |
| 12 | Pass (daemon, unchanged) | Same daemon code: the cleared session id makes the next spawn a `session/new` seeded with the handoff |
| 13 | Pass (unchanged) | Same check, before either transport starts |
| 14 | Pass (unchanged) | Same classifier (`stream::failed`) for prompt errors and error steps |
| 15 | Pass (unchanged) | Pass: `agys_recorded_errors_fail_the_turn_as_print_words_them` (`choose_model` before the model answered, Try again after), `steps_after_the_mark_tell_an_error_and_whether_the_model_answered`. The error's chat text shows once, as the failure: `an_error_agy_reports_as_text_shows_once_and_a_warning_that_isnt_one_still_shows` (see "An error shown once" below) |
| 16 | Pass (unchanged) | Pass (scripted): an ACP `refusal` (agy's exhausted quota) reads the reset time from the prompt's last error step, else from the words agy sent with it: `an_exhausted_quota_says_when_it_resets`. Not seen on a real exhausted quota: what agy 1.5.14 sends with a refusal is T3 Code's account, and with neither an error step nor words the hint says to wait for the reset |
| 17 | Pass (unchanged) | Not applicable: no repeated `result.error` on ACP |
| 18 | Pass (unchanged) | Core: a prompt that never reached agy re-offers the guide (`restore_guide`) |
| 19 | Pass (unchanged) | Pass: `a_crash_mid_turn_fails_it_plainly_and_ends_the_session_for_a_respawn`; startup failures worded in `startup_problem` |
| 20 | Pass (unchanged) | Pass: agy's own tool name kept through `_meta`, same `tools::normalize`; live (`Bash` with `command`) |
| 21 | Pass (unchanged) | Pass: `mcp_calls_read_as_their_tool_and_schema_reads_stay_hidden` |
| 22 | Pass (unchanged) | Pass: same test, and `agys_tool_names_and_prompt_usage_survive_acps_types` |
| 23 | Pass (unchanged) | ACP's `rawInput` is complete in every recorded call, so the transcript fallback is not used there |
| 24 | Pass (unchanged) | Pass: `tool_results_read_as_print_reads_them` |
| 25 | Pass (unchanged) | Pass: `the_guide_goes_in_the_system_prompt_once_and_the_bridge_only_in_the_environment` (no `mcpServers`, credentials only in agy's environment) |
| 26 | Pass (unchanged) | Pass: same test (system prompt when advertised, else first prompt once; a resume that lacks it gets it on the next prompt). agy keeps the system-prompt append in a resumed conversation, so a resume sends nothing: live `antigravity_on_acp_keeps_the_guide_in_a_resumed_conversation` (a new process loads the conversation and answers from the guide; a session without it can't) |
| 27 | Pass (daemon, unchanged) | Same daemon code |
| 28 | Pass (unchanged) | Same refusal before either transport |
| 29 | Pass (unchanged; `-p` and forced `-p` still Full access only) | Every mode: `supervised_asks_…`, `full_access_and_accept_edits_answer_without_a_card_where_they_should`, `auto_runs_agys_own_review_only_when_the_session_offers_it`, `agys_own_question_is_a_question_card`; daemon `antigravity_on_acp_takes_every_mode_wherever_one_is_set`; live `antigravity_supervised_asks_before_a_command_on_acp`. The rule is checked only where a mode or harness is chosen or changed, so a thread already in its mode ends its turns, queues and archives whatever agy was last found to take: daemon `a_thread_in_its_mode_finishes_its_turns_and_archives_whatever_agy_was_last_found_to_take`. A refusal carries its problem (update agy, Try again, Full access only): `a_failed_acp_check_is_retried_for_a_mode_only_acp_runs_and_for_a_new_agy_version`. Another machine's mode is that machine's to check, and its refusal names it: daemon `the_machine_that_runs_antigravity_decides_its_mode_and_names_itself_when_it_refuses`, `a_refusal_for_another_machine_names_it_and_offers_only_what_runs_here`. Checked by hand on a scratch daemon (agy 1.5.14): a Supervised thread right after the daemon started ran a turn, asked before a command, and archived |
| 30 | Pass (unchanged) | Same |
| 31 | Pass (unchanged; live) | Not applicable: title one-shots always run on `-p` |
| 32–34 | Pass (unchanged) | Same code; the probe also reports every mode when ACP is usable. The check that `agy acp` initializes holds for the version agy reports (a `.cmd` or npm launcher doesn't change when agy updates); a failure holds for five minutes and never across a restart, and a mode only ACP runs checks it again at once: `an_acp_check_holds_for_its_version_and_a_failure_only_for_a_while`, `a_failed_acp_check_is_retried_…` |
| 35 | Pass (unchanged) | `agy acp` starts through the same `binary::command` (`.cmd` shims) |
| 36 | Pass (unchanged) | Same `resolve` and `env_home` |
| 37 | Pass (unchanged) | ACP conversations are agy's own, in the same store |
| 38 | Pass (unchanged) | Image blocks (`agy acp` advertises `promptCapabilities.image`) |
| 39 | Pass (unchanged) | The flavor owns the log file's scratch folder and removes it with the session |

## ACP only: background work and failures

| Behaviour | Covered by |
|-----------|------------|
| A backgrounded command holds its turn until agy's reply to it closes; a reply agy starts by itself is a turn of its own | `a_command_that_outlives_its_prompt_holds_the_turn_until_agys_reply_to_it`, `a_reply_agy_starts_by_itself_is_a_turn_of_its_own` (waits for the first turn's end, not a sleep), `acp::turn` tests |
| A tool whose end never comes (a stopped or failed turn, a missed update) never holds or keeps busy a later turn: a turn's end clears its open tool calls, and a completed prompt is held for an outliving command only while agy is heard from within 30 minutes | `a_command_whose_end_never_came_does_not_hold_the_next_turn`, `a_command_whose_end_never_comes_holds_its_prompt_only_while_agy_is_heard_from` |
| A prompt agy leaves silent fails after 15 minutes; a card waiting for the user, a running tool or a sleeping host is not silence | `a_silent_prompt_fails_but_waiting_on_a_tool_the_user_or_a_sleeping_host_does_not` |

### An error shown once

On ACP agy reports a failure as chat text (`\n⚠ …`) and `end_turn`, and records an error step
(type 17) in the conversation's database. Kybern withholds a chunk whose conversation's newest
step is an error step, and the turn fails with the step's text as its problem. Confirmed on agy
1.5.14 in a scratch home: with its HTTPS proxy pointed at a closed port, five prompts out of five
failed with "⚠ failed to construct executor: …", and the error step was already the newest row
each time the chunk arrived. agy rejects an unknown model id at `session/set_config_option`
("Unknown model ID"), and truncates an oversized prompt instead of failing, so a failure from the
model API itself was not reproduced. For one whose step lands after its text, a chunk that starts
with `⚠` and has no error step yet is held: it is dropped if the turn then fails, and shown with
the next text or at the end of a successful turn.
