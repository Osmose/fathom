/**
 * An algorithm that finds the main human-readable content of a web page, like
 * Readability
 *
 * Potential advantages over readability:
 * * State clearly contained
 * * Should work fine with ideographic languages and others that lack
 *   space-delimited words
 * * Pluggable
 * * Rules automatically tuneable
 * * Potential to have rules generated by learning algorithms
 * * Adaptable to find things other than the main body text (like
 *   clusters of nav links)
 * * Potential to perform better since it doesn't have to run over and
 *   over, loosening constraints each time, if it fails
 * * Happily finds body text in things other than divs and p tags.
 */
const {readFileSync} = require('fs');
const {dirname, join} = require('path');

const leven = require('leven');

const {dom, props, out, rule, ruleset, score, type} = require('../index');
const {domSort, inlineTextLength, linkDensity, staticDom} = require('../utils');


/**
 * The main entrypoint. Return a contentFnodes(dom) function that extracts the
 * content from a DOM.
 *
 * Take a bunch of optional coefficients to tune its behavior. Default is to
 * use the best-performing coefficients we've come up with so far.
 */
function tunedContentFnodes(coeffLinkDensity = 1.5, coeffParagraphTag = 4.5, coeffLength = 2, coeffDifferentDepth = 6.5, coeffDifferentTag = 2, coeffSameTag = 0.5, coeffStride = 0) {
    // The default coefficients are the ones that score best against a
    // subset of Readability test cases.

    // Score a node based on how much text is directly inside it and its
    // inline-tag children.
    function scoreByLength(fnode) {
        const length = inlineTextLength(fnode.element) * coeffLength;
        return {
            score: length,  // May be scaled someday
            note: {inlineLength: length}  // Store expensive inline length for linkDensity().
        };
    }

    // This set of rules is the beginning of something that works.
    // It's modeled after what I do when I try to do this by hand: I look
    // for balls of black text, and I look for them to be near each other,
    // generally siblings: a "cluster" of them.
    const rules = ruleset(
        // Score on text length -> paragraphish. We start with this
        // because, no matter the other markup details, the main body text
        // is definitely going to have a bunch of text.
        rule(dom('p,div,li,code,blockquote,pre,h1,h2,h3,h4,h5,h6'), props(scoreByLength).type('paragraphish')),
        // TODO: Consider a "blur" algorithm within the cluster, pulling in
        // other elements with decent text density, good CSS smells, and such.
        // (Interstitials like those probably won't split clusters if the
        // stride cost is set low enough.) To test, add a very short paragraph
        // in the midst of the long one, thus testing our leaning toward
        // contiguousness.

        // Scale it by inverse of link density:
        rule(type('paragraphish'), score(fnode => (1 - linkDensity(fnode, fnode.noteFor('paragraphish').inlineLength)) * coeffLinkDensity)),

        // Give bonuses for being in p tags.
        rule(dom('p'), score(coeffParagraphTag).type('paragraphish')),
        // TODO: article tags, etc., too

        // TODO: Ignore invisible nodes so people can't game us with those.

        rule(type('paragraphish')
                .topTotalingCluster({splittingDistance: 3,
                                     // This is an addition to the distance
                                     // function which makes nodes that have
                                     // outlier lengths further away. It's
                                     // meant to help filter out interstitials
                                     // like ads.
                                     // +1 to make a zero difference in length
                                     //     be 0
                                     // /10 to bring (only) large differences
                                     //     in length into scale with the above
                                     //     costs
                                     // additionalCost: (a, b) => Math.log(Math.abs(a.noteFor('paragraphish').inlineLength -
                                     //                                             b.noteFor('paragraphish').inlineLength) / 10 + 1)
                                     // TODO: Consider a logistic function
                                     // instead of log.
                                     differentDepthCost: coeffDifferentDepth,
                                     differentTagCost: coeffDifferentTag,
                                     sameTagCost: coeffSameTag,
                                     strideCost: coeffStride}),

             type('content')),
        rule(type('content'), out('sortedContent').allThrough(domSort))
    );

    // Return the fnodes expressing a document's main textual content.
    function contentFnodes(doc) {
        const facts = rules.against(doc);
        return facts.get('sortedContent');

        // TODO: Use score as part of the distance metric, which should tend to
        // push outlier-sized paragraphs out of clusters, especially if they're
        // separated topographically (like copyright notices).

        // Other ideas: We could pick the cluster around the highest-scoring
        // node (which is more like what Readability does) or the highest-
        // scoring cluster by some formula (num typed nodes * scores of the
        // nodes), and contiguous() it so things like ads are excluded but
        // short paragraphs are included.
    }

    return contentFnodes;
}

/** Return the concatenated textual content of an entire DOM tree. */
function textContent(dom) {
    // dom.textContent crashes. dom.firstChild is always an HTML element in
    // jsdom, even if you didn't include one.
    return dom.firstChild.textContent;
}

/** Remove leading and trailing whitespace from each line of a string. */
function trimLines(str) {
    const lines = str.split('\n');
    return lines.map(l => l.trim()).join('\n');
}

/** Replace runs of line breaks with single ones. */
function collapseNewlines(str) {
    return str.replace(/\n\n+/g, '\n');
}

/**
 * Maintain state as we compare a series of DOMs, reporting the percent
 * difference at the end.
 */
class DiffStats {
    constructor(contentFnodes) {
        this.lengthOfExpectedTexts = 0;
        this.lengthOfDiffs = 0;
        this.contentFnodes = contentFnodes || tunedContentFnodes();
    }

    /**
     * Run our Readability-alike algorithm over a DOM, and measure the
     * difference from the expected result, where the difference is
     * defined in accordance with the needs of human reading. Sock the
     * results away to produce a total score later.
     *
     * This will get continually pickier over time as we run up against
     * the limits of its discriminatory power.
     */
    compare(expectedDom, sourceDom) {
        // Currently, this is just a surrounding-whitespace-
        // insensitive comparison of the text content.
        const expectedText = collapseNewlines(trimLines(textContent(expectedDom)));
        const gotText = collapseNewlines(trimLines(this.contentFnodes(sourceDom).map(fnode => fnode.element.textContent).join('\n')));
        this.lengthOfExpectedTexts += expectedText.length;
        this.lengthOfDiffs += leven(expectedText, gotText);

        // Uncomment for debugging:
        // console.log('Got:\n' + gotText);
        // console.log('\nExpected:\n' + expectedText);
    }

    /**
     * Compare 2 HTML files in a named directory within the
     * readability test folder.
     */
    compareFilesIn(folder) {
        this.compare(...expectedAndSourceDocs(folder));
    }

    score() {
        return this.lengthOfDiffs / this.lengthOfExpectedTexts * 100;
    }
}

function expectedAndSourceDocs(folder) {
    const domFromFile = fileName => staticDom(readFileSync(join(dirname(__dirname), 'test', 'readability_test_data', folder, fileName)));
    return [domFromFile('expected.html'),
            domFromFile('source.html')];
}

function deviationScore(docPairs, coeffs = []) {
    const stats = new DiffStats(tunedContentFnodes(...coeffs));
    for (let pair of docPairs) {
        stats.compare(...pair);
    }
    return stats.score();
}

/** Return (expected DOM, source DOM) for all the readbaility test docs. */
function readabilityDocPairs() {
    return ['basic-tags-cleaning',
            '001',
            //'002', // hellish number of candidate tags. Takes 14s.
            'daringfireball-1',
            'buzzfeed-1',
            'clean-links',
            'ehow-1',
            'embedded-videos',
            'heise',
            'herald-sun-1'].map(expectedAndSourceDocs);
}

if (require.main === module) {
    // By default, just run the Readability examples and show how our current
    // coefficients score on them.
    const {Annealer} = require('../optimizers');
    const {argv} = require('process');

    let coeffs = [1.5, 4.5, 2, 6.5, 2, 0.5, 0];

    class ContentFnodesTuner extends Annealer {
        constructor() {
            super();
            const docPairs = readabilityDocPairs();
            this.solutionCost = coeffs => deviationScore(docPairs, coeffs);
        }

        randomTransition(solution) {
            // Nudge a random coefficient in a random direction.
            const ret = solution.slice();
            ret[Math.floor(Math.random() * solution.length)] += Math.floor(Math.random() * 2) ? -.5 : .5;
            return ret;
        }

        initialSolution() {
            return coeffs;
        }
    }

    if (argv[2] == '--tune') {
        // Tune coefficients using simulated annealing.
        const annealer = new ContentFnodesTuner();
        coeffs = annealer.anneal();
    }
    console.log('Tuned coefficients:', coeffs);
    console.log('% difference from ideal:',
                deviationScore(readabilityDocPairs(), coeffs));
}

module.exports = {
    deviationScore,
    readabilityDocPairs,
    textContent,
    tunedContentFnodes
};
