# Research: Neural networks for engineers (neural-networks-basics)

Researched November 2026. Track: ai-engineering (LLM foundations, #1). Shape: single topic.

## Key facts (with sources)

- A fully-connected layer's forward pass, activation gradients and weight gradients are each a
  matrix-matrix multiplication (GEMM). NVIDIA Deep Learning Performance docs, "Linear/Fully-Connected
  Layers User's Guide" (current, read Nov 2026).
  https://docs.nvidia.com/deeplearning/performance/dl-performance-fully-connected/index.html
- Without a nonlinear activation, hidden layers collapse: "an affine function of an affine function is
  itself an affine function". ReLU = max(0, x). Dive into Deep Learning, ch. 5.1 (2023, Cambridge UP
  edition, online). https://d2l.ai/chapter_multilayer-perceptrons/mlp.html
- Google ML Crash Course, activation functions (updated 2025-08-25): linear on linear is still linear;
  sigmoid squashes to 0..1. https://developers.google.com/machine-learning/crash-course/neural-networks/activation-functions
- Learning rate too low: slow to converge; too high: "never converges", bounces around the minimum.
  Google MLCC, hyperparameters (updated 2025-12-03).
  https://developers.google.com/machine-learning/crash-course/linear-regression/hyperparameters
- Overfitting signature: training and validation loss curves start together, then validation rises
  while training keeps falling. Google MLCC, interpreting loss curves (updated 2025-12-03).
  https://developers.google.com/machine-learning/crash-course/overfitting/interpreting-loss-curves
- With 1% positives, a model that always says "negative" scores 99% accuracy and is useless. Google
  MLCC, accuracy/precision/recall (updated 2026-01-12).
  https://developers.google.com/machine-learning/crash-course/classification/accuracy-precision-recall
- Class-imbalanced data: majority / minority class, downsampling and upweighting. Google MLCC (2025).
  https://developers.google.com/machine-learning/crash-course/overfitting/imbalanced-datasets
- PyTorch training loop: zero_grad, loss.backward(), optimizer.step(); gradients add up by default;
  example hyperparameters lr 1e-3, batch 64, 5 epochs. Epoch = one pass over the dataset. PyTorch
  "Optimizing model parameters" tutorial (current, read Nov 2026).
  https://docs.pytorch.org/tutorials/beginner/basics/optimization_tutorial.html
- Autograd records operations in a directed acyclic graph and traces it backwards to get gradients;
  torch.no_grad() for inference only. PyTorch autograd tutorial (updated Jan 2024, verified Nov 2024).
  https://docs.pytorch.org/tutorials/beginner/basics/autogradqs_tutorial.html
- Gmail: replacing the spam classifier's text vectorizer with RETVec raised spam detection by 38% over
  baseline, cut false positives by 19.4%, cut TPU use by 83%; ~200k-parameter embedding feeding a
  Transformer; spammers use homoglyphs, invisible characters, keyword stuffing. Google Security
  Blog, Nov 2023. https://security.googleblog.com/2023/11/improving-text-classification.html
- Llama 3: largest model is a dense Transformer with 405B parameters, 15.6T training tokens, up to
  16K H100 GPUs, 3.8×10^25 FLOPs, 380–430 TFLOPs per GPU achieved (38–43% MFU). 466 job
  interruptions in a 54-day snapshot, ~78% of the unexpected ones hardware. Sizes 8B, 70B, 405B.
  Meta, "The Llama 3 Herd of Models", arXiv 2407.21783 (Jul 2024, rev. Nov 2024).
- Training compute ≈ 6 × parameters × tokens; forward pass ≈ 2 × parameters per token. Kaplan et
  al., "Scaling laws for neural language models" (Jan 2020). https://arxiv.org/abs/2001.08361
  Check: 6 × 405e9 × 15.6e12 = 3.79e25, matches Meta's 3.8e25.
- H100 SXM: 1,979 TFLOPS BF16 "with sparsity"; half that (~989) without. NVIDIA H100 page (read Nov 2026).
  https://www.nvidia.com/en-us/data-center/h100/
- Tree-based models (XGBoost, random forests) still beat deep learning on typical tabular data
  (45 datasets). Grinsztajn, Oyallon, Varoquaux, NeurIPS 2022. https://arxiv.org/abs/2207.08815
- Networks can fit random labels perfectly: memorisation capacity. Zhang et al., "Understanding deep
  learning (still) requires rethinking generalization", CACM 2021 (original ICLR 2017).
  https://cacm.acm.org/research/understanding-deep-learning-still-requires-rethinking-generalization/
  (CACM page blocked our fetcher; abstract confirmed on arXiv 1611.03530.)
- micrograd (Karpathy, 2020): a scalar autograd engine in ~100 lines, the clearest from-scratch
  backprop to read. https://github.com/karpathy/micrograd

## Numbers used on the page (all from examples/neural-networks-basics, run Nov 2026)

- Part 1 neuron: inputs [6, 4, 0], weights [0.5, 0.8, −3], bias −4 → score 2.2 → sigmoid 0.90.
  Friend's email [1, 0, 1] → −6.5 → 0.0015.
- Part 2 forward pass: A = [0.2, 0.5, −1], bias −1 → 2.2; B = [−0.3, 0.1, 2], bias 0.5 → −0.9 → ReLU 0;
  output [1.5, −2], bias −2 → 1.3 → 0.786; log loss 0.241.
- Backprop: blame at output −0.214; A gets −0.321; B 0; A's weight gradients [−1.927, −1.285, 0];
  with lr 0.1, A's weights → [0.393, 0.628, −1.0], output weight 1.547; new spam chance 0.983, loss 0.017.
- Dataset: 100 synthetic emails (75 train, 25 validation), 4 deliberately mislabelled.
  Rules: 75% right. One neuron: 81% train, 84% validation. 3→8→1 network with early stopping:
  95% train, 100% validation; its 4 training mistakes are exactly the 4 mislabelled emails.
  Stopped at epoch 637, best validation loss 0.076 at epoch 337.
- Sim (train-core.ts): one neuron ≈ 83–87% validation; 6 hidden ≈ 92%; 12 hidden on 15 emails:
  training loss → 0.000, validation loss rises past 4, validation accuracy 67%.

## Misconceptions and confusing points

- "A neuron is like a brain cell": only loosely; it is a weighted sum plus a squash.
- "More layers always help": without activations they collapse into one layer; with them, more
  capacity also means more memorising.
- "The model learns while I chat with it": inference does not change weights.
- "99% accuracy is great": not with imbalanced classes.
- Backprop vs gradient descent: backprop computes the gradients; gradient descent uses them.
- Loss vs accuracy: loss is smooth and can improve while accuracy does not move.

## How popular explainers structure it, and our angle

- Google MLCC: linear regression → logistic regression → neural nets, many separate modules.
  Mathematical but scattered; a reader has to stitch it together.
- 3Blue1Brown-style video series (pre-2020, not cited): digit recognition, visual, no code, stops before
  production concerns.
- Karpathy's micrograd / Zero to Hero (2022): code-first, excellent, but assumes comfort with calculus.
- Our angle: one email followed end to end with numbers worked by hand, every maths idea refreshed,
  backprop as "handing back blame" with real numbers, then what an engineer must know in production:
  GPUs as matrix machines, overfitting, scaling inputs, class imbalance, drift, training vs inference,
  and when not to use a network at all.

## Fresher read

Done 2026-11-12 by a fresh agent with none of the research in context, then a full publishing read
by the author. All arithmetic on the page was re-checked; none was wrong. Items found and fixed:

- 75/25 split and "held-back emails" now stated before the 84% claim; "validation" defined later.
- 2 × 2 = 4 step shown for the backward-pass cost; sign flip in e^(6.5) explained.
- Gradient-descent example says why the known-sender weight and bias do not move.
- Backprop update gives the new biases (−0.968, −1.979) so the 0.983 check can be followed.
- Sentence added before the loss-valley figure; matrix × grid explained; powers of ten and their
  division shown; 65,536 tied to 2¹⁶; "41%" replaced by 400 ÷ 989 ≈ 40%.
- Sim's separate dataset (120 + 60 emails, two inputs) stated before the sim.
- "perceptron", "model", "fine-tune", "1e-12", "batch" (in Going deeper) explained or avoided.
- Repetition cut: duplicate PyTorch loop, recap repeat of "does not learn from users", overfitting
  preview, "impossible" sentence.
- Publishing read: a list item that broke into a nested list, "Three of them" (refresher count),
  "nonlinear" used before defined, awkward 16-bit sentence.

Open list: empty.
