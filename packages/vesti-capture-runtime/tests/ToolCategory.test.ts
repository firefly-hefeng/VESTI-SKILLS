/**
 * ToolCategory Tests
 */

import { describe, it, expect } from 'vitest';
import { classifyTool } from '../src/types/unified.js';

describe('classifyTool', () => {
  it('should classify shell tools', () => {
    expect(classifyTool('Bash')).toBe('shell');
    expect(classifyTool('Shell')).toBe('shell');
  });

  it('should classify file_read tools', () => {
    expect(classifyTool('Read')).toBe('file_read');
    expect(classifyTool('ReadFile')).toBe('file_read');
    expect(classifyTool('readCode')).toBe('file_read');
  });

  it('should classify file_write tools', () => {
    expect(classifyTool('Write')).toBe('file_write');
    expect(classifyTool('WriteFile')).toBe('file_write');
  });

  it('should classify file_edit tools', () => {
    expect(classifyTool('Edit')).toBe('file_edit');
    expect(classifyTool('NotebookEdit')).toBe('file_edit');
  });

  it('should classify search tools', () => {
    expect(classifyTool('Glob')).toBe('search');
    expect(classifyTool('Grep')).toBe('search');
    expect(classifyTool('WebSearch')).toBe('search');
  });

  it('should classify agent tools', () => {
    expect(classifyTool('Task')).toBe('agent');
    expect(classifyTool('TaskCreate')).toBe('agent');
    expect(classifyTool('Agent')).toBe('agent');
  });

  it('should classify git tools', () => {
    expect(classifyTool('GitCommit')).toBe('git');
    expect(classifyTool('GitPush')).toBe('git');
    expect(classifyTool('GitStatus')).toBe('git');
  });

  it('should classify interaction tools', () => {
    expect(classifyTool('AskUserQuestion')).toBe('interaction');
    expect(classifyTool('PromptUser')).toBe('interaction');
  });

  it('should classify planning tools', () => {
    expect(classifyTool('SetTodoList')).toBe('planning');
    expect(classifyTool('EnterPlanMode')).toBe('planning');
    expect(classifyTool('ExitPlanMode')).toBe('planning');
    expect(classifyTool('TodoWrite')).toBe('planning');
    expect(classifyTool('CronCreate')).toBe('planning');
    expect(classifyTool('Skill')).toBe('planning');
    expect(classifyTool('EnterWorktree')).toBe('planning');
  });

  it('should return other for unknown tools', () => {
    expect(classifyTool('UnknownTool')).toBe('other');
    expect(classifyTool('CustomMCPTool')).toBe('other');
  });
});
